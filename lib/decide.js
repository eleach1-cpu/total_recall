'use strict';
const { loadConfig, noConfigMessage } = require('./config');
const { openStore, sha256, decisionQuoteKey } = require('./store');
const { scrub } = require('./scrub');

// A decision recorded WHILE the work is happening, by the assistant that was in the conversation.
//
// What a record is, and is not:
//   - the owner's exact words (`quote`) are the decision; they are checked against the ingested
//     conversation and the record is only ACTIVE once they have been found there;
//   - `statement` and `scope` are the assistant's READING of those words, and are shown as that;
//   - the evidence is never typed in: it is the owner's turn the quote was found in, plus the
//     proposal that turn answered. Until that turn is in the store the record is PENDING, with no
//     ids at all. Nobody invents a transcript id;
//   - the conversation stays the authority. A record helps find the exchange; it never replaces it,
//     and a past approval is not fresh permission to spend, publish or deploy.
const OUTCOMES = new Set(['approved', 'rejected', 'standing', 'open']);
const CLIENTS = new Set(['claude', 'codex']);
// A rule for all future work says so. "Fix the header" is an instruction for one task.
const GENERAL = /\b(never|always|from now on|going forward|every time|each time|any time|whenever|in future|by default|do not ever|don't ever|no more|stop (doing|using|saying)|must (always|never)|rule)\b|\b(do not|don't|never)\b[^.]*\bagain\b/i;
const SHORT_WORDS = 6;

const collapse = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
const words = (s) => collapse(s).split(' ').filter(Boolean);

// The phrase as whole words: "go" is not found inside "google".
function containsPhrase(body, quote) {
  const b = collapse(body), q = collapse(quote);
  if (!q) return false;
  for (let i = b.indexOf(q); i !== -1; i = b.indexOf(q, i + 1)) {
    const before = i === 0 ? ' ' : b[i - 1], after = i + q.length >= b.length ? ' ' : b[i + q.length];
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
  }
  return false;
}

function check(input) {
  const e = (m) => ({ error: m });
  const outcome = String(input.outcome || '').toLowerCase();
  if (!OUTCOMES.has(outcome)) return e(`outcome must be one of ${[...OUTCOMES].join(', ')} (a change is an approval, rejection or rule that names what it replaces)`);
  const client = String(input.client || '').toLowerCase();
  if (!CLIENTS.has(client)) return e('say which assistant is recording: --client claude or --client codex');
  const quote = scrub(String(input.quote || '').trim());
  if (!quote) return e('give the owner\'s exact words (--quote)');
  if (quote.length > 400) return e('quote the deciding words, not the whole message (400 characters at most)');
  if (/\?\s*$/.test(quote)) return e('that quote is a question; a question is not a decision');
  const statement = scrub(String(input.statement || '').trim());
  if (statement.length < 12 || collapse(statement) === collapse(quote)) return e('say WHAT was decided (--what): an "approved" has to identify the thing that was approved');
  const scope = scrub(String(input.scope || '').trim());
  if (!scope) return e('say what it covers (--scope), for example "this commit", "the pension page", "all future work"');
  let certainty = input.certainty === 'unclear' ? 'unclear' : 'clear';
  let note = null;
  if (outcome === 'standing' && certainty === 'clear' && !GENERAL.test(quote)) {
    // The words do not themselves say "always": kept, but never promoted to a rule on an assistant's say-so.
    certainty = 'unclear';
    note = 'the quoted words do not state a general rule, so this is held as UNCLEAR and is not shown as a standing rule';
  }
  return { ok: { outcome, client, quote, statement: statement.slice(0, 300), scope: scope.slice(0, 120), certainty, note,
    reason: input.reason ? scrub(String(input.reason).trim()).slice(0, 300) : null,
    contextQuote: input.contextQuote ? scrub(String(input.contextQuote).trim()) : null,
    replaces: input.replaces ? Number(input.replaces) : null, conflictsWith: input.conflictsWith ? Number(input.conflictsWith) : null } };
}

const bodyOf = (r, linked) => [`${r.statement} (scope: ${r.scope})`, `owner said: ${r.quote}`, r.reason ? `reason: ${r.reason}` : null,
  r.certainty === 'unclear' ? 'meaning or scope UNCLEAR: not a confident approval, not a standing rule' : null,
  linked ? `session ${linked.session} ${linked.ts.slice(0, 10)}` : 'PENDING: the owner\'s words have not been found in the ingested conversation yet'].filter(Boolean).join('\n');

// The exchange the record describes: the owner's turn that holds the quote AND, in the same
// conversation just before it, the proposal given as context. "approved, do it" is said in many
// conversations; the words alone never choose one.
//   - the calling session, when the host names it, is the only conversation searched;
//   - context that was given and is not found before a candidate rules that candidate out. It is
//     never swapped for whatever proposal happens to sit there: unresolved beats wrong;
//   - every eligible exchange is considered; multiple matches stay unresolved even when
//     they share the supplied context or occur in the same known conversation.
const CONTEXT_WINDOW = 12; // spoken turns before the owner's message
function findEvidence(store, rec, quote, contextQuote) {
  const at = Date.parse(rec.recorded_at || rec.ts);
  let turns = store.ownerTurnsBetween(rec.source_client, new Date(at - 24 * 3600000).toISOString(), new Date(at + 2 * 60000).toISOString());
  if (rec.session) turns = turns.filter((t) => t.session_id === rec.session);
  const { fuzzyQuote } = require('./distill');
  const holds = (body, words) => containsPhrase(body, words) || !!fuzzyQuote(body, words);
  const hits = [];
  for (const t of turns) { // newest first
    if (containsPhrase(t.body, quote)) hits.push({ turn: t, quote });
    else { const fz = fuzzyQuote(t.body, quote); if (fz) hits.push({ turn: t, quote: fz }); }
  }
  if (!hits.length) return { why: 'the quoted words are not in the ingested conversation yet' };
  if (!contextQuote && !rec.session) {
    const n = new Set(hits.map((h) => h.turn.session_id)).size;
    if (n > 1) return { ambiguous: true, why: `those words were said in ${n} conversations; give --context with a few words of the proposal that was answered` };
  }
  const candidates = [];
  for (const h of hits) {
    const earlier = store.spokenTurnsBefore(h.turn.session_id, h.turn.ts, h.turn.id, CONTEXT_WINDOW);
    if (contextQuote) {
      const ctx = earlier.find((t) => holds(t.body, contextQuote));
      if (ctx) candidates.push({ ...h, context: ctx });
      continue;
    }
    candidates.push({ ...h, context: earlier.find((t) => t.role === 'assistant') || null });
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) return {
    ambiguous: true,
    why: `${candidates.length} exchanges match the quoted words and context; supply a known conversation or more specific context, not the newest match`,
  };
  return { why: 'the owner\'s words were found, but not after the proposal given as context; left unresolved rather than attached to a different exchange' };
}

// Whether the OWNER's later words replace an earlier decision is never taken from the recorder's
// label, shared words or semantic similarity. A narrow owner-authored confirmation binds
// the OLD record id to the NEW quoted instruction. Other wording stays a conflict.
const MAY_REPLACE = { standing: ['standing'], approved: ['approved', 'rejected'], rejected: ['approved', 'rejected'], open: ['approved', 'rejected', 'open'] };
function relationFor(old, neu, meta, ownerTurn) {
  if (!old || old.kind !== 'statement' || old.id === neu.id) return null;
  const no = (why) => ({ type: 'conflict', why });
  if (meta.certainty !== 'clear') return no('the new decision is itself recorded as unclear');
  if (old.who !== 'owner' || old.status !== 'active') return no('the earlier record is not a live owner decision');
  if (!old.evidence_ids || old.evidence_ids === '[]') return no('the earlier record is not linked to a conversation, so "later" cannot be shown');
  if (!(neu.ts > old.ts)) return no('the new words were not said AFTER the earlier decision');
  if (!(MAY_REPLACE[old.outcome] || []).includes(neu.outcome)) return no(`an "${neu.outcome}" does not replace a "${old.outcome}": approving one thing does not repeal a rule`);
  if (!ownerTurn || ownerTurn.role !== 'user' || (ownerTurn.origin && ownerTurn.origin !== 'direct')) {
    return no('replacement requires a direct owner message, not the recorder\'s assertion');
  }
  const directive = /^Replace decision #([1-9]\d*) with:\s*([\s\S]+)$/iu.exec(String(ownerTurn.body || '').trim());
  const quoted = decisionQuoteKey(neu.quote);
  if (!directive || Number(directive[1]) !== old.id ||
      (decisionQuoteKey(directive[2]) !== quoted && decisionQuoteKey(ownerTurn.body) !== quoted)) {
    return no(`same subject is not proof of replacement; the owner must explicitly say "Replace decision #${old.id} with: <the new instruction>"`);
  }
  return { type: 'replaces', why: `the linked owner message explicitly replaces decision #${old.id} with the new quoted instruction` };
}

function tryLink(store, doc, meta, resolved = null) {
  const ev = resolved || findEvidence(store, { source_client: meta.client, recorded_at: meta.recorded_at, session: meta.session || null }, meta.quote, meta.contextQuote);
  if (!ev.turn) return { linked: false, ambiguous: !!ev.ambiguous, why: ev.why };
  // A bare "yes" or "go" means nothing without the thing it answered.
  if ((meta.outcome === 'approved' || meta.outcome === 'rejected') && words(meta.quote).length < SHORT_WORDS && !ev.context) {
    return { linked: false, why: 'a short reply needs the proposal it answered, and none was found before it' };
  }
  const evidence = [...(ev.context ? [ev.context.id] : []), ev.turn.id];
  store.linkDecision(doc.id, { session_id: ev.turn.session_id, source_client: ev.turn.source_client || meta.client, ts: ev.turn.ts,
    evidence_ids: JSON.stringify(evidence), quote: ev.quote, body: bodyOf({ ...meta, quote: ev.quote }, { session: ev.turn.session_id, ts: ev.turn.ts }) });
  // A replacement is only ever drawn from the OWNER's later words, now found and linked, and only
  // when the records themselves show it (relationFor). Otherwise both stay and the clash is flagged.
  let relation = null;
  if (meta.replaces) {
    relation = relationFor(store.getDoc(meta.replaces), store.getDoc(doc.id), meta, ev.turn);
    if (relation) {
      store.putRelation(meta.replaces, doc.id, relation.type, meta.client);
      if (relation.type === 'replaces') store.linkStatement(meta.replaces, doc.id);
    }
  }
  if (meta.conflictsWith) { const old = store.getDoc(meta.conflictsWith); if (old && old.kind === 'statement' && old.id !== doc.id) store.putRelation(old.id, doc.id, 'conflict', meta.client); }
  store.dedupeStatements();
  return { linked: true, evidence, relation };
}

function record(store, cfg, input) {
  const c = check(input);
  if (c.error) return { error: c.error };
  const r = c.ok;
  const now = input.now || new Date().toISOString(); // `now` is only ever passed by tests
  // The conversation the record was made in, when the HOST names it (never a guess): the only one searched.
  const session = typeof input.session === 'string' && input.session ? input.session.replace(/^claude:/i, '') : null;
  const meta = { ...r, recorded_at: now, session };
  const resolved = findEvidence(store, { source_client: r.client, recorded_at: now, session }, r.quote, r.contextQuote);
  // Identical words said in a later exchange are a different event, including an owner's
  // explicit confirmation of a previously suggested replacement. Pending records get a
  // provisional key; normal evidence-based deduplication runs after they can be linked.
  const eventKey = resolved.turn ? [resolved.turn.session_id, resolved.turn.id] : [session, now, r.contextQuote];
  const ins = store.insertDoc({
    project: cfg.project, kind: 'statement', status: 'pending', ts: now, title: `${r.statement} (scope: ${r.scope})`, body: bodyOf(r, null),
    who: 'owner', outcome: r.outcome, quote: r.quote, reason: r.reason, evidence_ids: '[]', path: `decide:${r.client}`, source_client: r.client,
    origin: r.certainty === 'unclear' ? 'decision-unclear' : 'decision', adapter: `decide/${r.client}`,
    // What was asked for, kept on the row so a later ingest can finish the job without the assistant.
    item_key: JSON.stringify({ quote: r.quote, contextQuote: r.contextQuote, replaces: r.replaces, conflictsWith: r.conflictsWith, recorded_at: now, session, statement: r.statement, scope: r.scope, reason: r.reason, certainty: r.certainty }),
    // The same decision recorded twice (the assistant, then the handoff) is one record.
    sha: sha256(JSON.stringify(['decision2', r.client, eventKey, r.outcome, decisionQuoteKey(r.quote), decisionQuoteKey(r.statement), r.scope])),
  });
  const doc = store.getDoc(ins.id);
  if (!ins.inserted) return { id: doc.id, duplicate: true, status: doc.status, note: r.note };
  const l = tryLink(store, doc, meta, resolved);
  const rel = l.relation ? `#${r.replaces}: ${l.relation.type === 'replaces' ? 'REPLACED' : 'kept, flagged as a CONFLICT'} (${l.relation.why})` : null;
  return { id: doc.id, status: l.linked ? 'active' : 'pending', evidence: l.evidence || [], why: l.why, note: [r.note, rel].filter(Boolean).join('; ') || null, relation: l.relation || null };
}

// Run by every ingest: records that were waiting for their conversation to arrive get checked now.
function linkPending(store) {
  const out = { linked: 0, waiting: 0, unverified: 0 };
  for (const doc of store.pendingDecisions()) {
    let m = null; try { m = JSON.parse(doc.item_key || 'null'); } catch {}
    if (!m || !m.quote) continue;
    const meta = { ...m, outcome: doc.outcome, client: doc.source_client };
    const result = tryLink(store, doc, meta);
    if (result.linked) { out.linked++; continue; }
    // Multiple real matches are not evidence that the owner never said the words.
    // Keep the record pending; activity in another conversation must not expire it.
    if (result.ambiguous) { out.waiting++; continue; }
    // The conversation around that moment IS in the store and the words are not in it: this is not
    // something the owner can be shown to have said. It stays out of every search, and says why.
    if (store.hasTurnAfter(doc.source_client, new Date(Date.parse(m.recorded_at) + 10 * 60000).toISOString())) { store.setStatus(doc.id, 'unverified'); out.unverified++; }
    else out.waiting++;
  }
  return out;
}

function line(d) {
  let ev = []; try { ev = JSON.parse(d.evidence_ids || '[]'); } catch {}
  const flag = d.status === 'active' ? '' : ` ${d.status.toUpperCase()}`;
  const unclear = d.origin === 'decision-unclear' ? ' UNCLEAR' : '';
  return [`- #${d.id} [owner ${d.outcome}${unclear}]${flag} ${String(d.ts).slice(0, 10)} recorded by ${String(d.adapter || '').replace('decide/', '')}`,
    `  owner said: "${d.quote}"`, `  ${String(d.adapter || '').replace('decide/', '')}'s reading: ${d.title}`,
    ev.length ? `  evidence: ${ev.map((id) => `T${id}`).join(', ')} (search "<words>" --deep shows the exchange)` : '  evidence: none yet'].join('\n');
}

// The block a handoff COLLECTS. It lists the records; it does not re-derive them.
function listing(store, f = {}) {
  const rows = store.decisions(f);
  if (!rows.length) return 'no decision records in that window\n';
  return ['## Decisions (recorded during the session; the conversation itself is the authority)', ...rows.map(line)].join('\n') + '\n';
}

function command(args) {
  const cfg = loadConfig();
  if (!cfg) { process.stdout.write(noConfigMessage() + '\n'); return 0; }
  const f = args.flags;
  const store = openStore(cfg.store);
  try {
    if (args.cmd === 'decisions') {
      const since = f.today ? new Date().toISOString().slice(0, 10) : typeof f.since === 'string' ? f.since : new Date(Date.now() - 86400000).toISOString().slice(0, 10);
      process.stdout.write(listing(store, { since, pending: !!f.pending, client: typeof f.client === 'string' ? f.client : undefined }));
      return 0;
    }
    if (args.cmd === 'unlink') {
      const id = Number(args.positional[0]);
      const n = id ? store.removeRelations(id) : 0;
      process.stdout.write(n ? `#${id} is no longer marked as replaced or in conflict; both records and their evidence are untouched\n` : 'nothing to unlink\n');
      return n ? 0 : 1;
    }
    // Bring the running conversation in first, briefly, so the words just said can be found.
    try { require('./ingest').run(cfg, { mode: 'new' }, store, { budgetMs: 1500 }); } catch {}
    // Claude Code names the running session in its environment; that conversation is the one searched.
    const { resolveSessionId } = require('./session');
    const session = typeof f.session === 'string' ? f.session : f.client === 'claude' ? resolveSessionId({ payload: null, flags: {}, client: 'claude' }) : null;
    const r = record(store, cfg, { session, outcome: f.outcome, client: f.client, quote: f.quote, statement: f.what, scope: f.scope, reason: f.reason,
      certainty: f.unclear ? 'unclear' : 'clear', contextQuote: f.context, replaces: f.replaces, conflictsWith: f['conflicts-with'] });
    if (r.error) { process.stderr.write(`total_recall decide: ${r.error}\n`); return 1; }
    const where = r.status === 'active' ? `linked to ${r.evidence.map((id) => `T${id}`).join(', ')}` : `PENDING (${r.why}); the next ingest links it`;
    process.stdout.write(`${r.duplicate ? 'already recorded' : 'recorded'} #${r.id}: ${where}${r.note ? `\nnote: ${r.note}` : ''}\n`);
    return 0;
  } finally { store.close(); }
}

module.exports = { record, linkPending, listing, check, containsPhrase, command, GENERAL };
