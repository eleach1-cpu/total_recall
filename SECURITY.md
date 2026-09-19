# Security reporting

Total Recall handles potentially sensitive conversation history. Do not attach real transcripts,
database files, API keys, private configuration or identifying screenshots to public issues.
Use a small synthetic example when reporting an ordinary bug.

## Report a vulnerability privately

Once private reporting is enabled, use GitHub's
[Report a vulnerability](https://github.com/eleach1-cpu/total_recall/security/advisories/new)
form, available under **Security → Advisories**. Reports submitted through that form are
private; ordinary issues and discussions are not.

If the private form is unavailable, do not publish the exploit or sensitive evidence. You
may open an issue saying only that you need a private security-reporting channel, and wait
for the maintainer to arrange one. Do not send credentials, even privately: describe the
credential type and rotate any exposed secret.

Include the affected version/commit, operating system, AI client, a synthetic reproduction,
the likely impact and any suggested mitigation. This project does not promise a response SLA
or a bug bounty. Early-access fixes target the current default branch; older versions do not
have a separate security-maintenance guarantee.

## Maintainer: enable private reporting when publishing

GitHub offers this feature for public repositories. Before announcing the public release,
open **Settings → Advanced Security → Private vulnerability reporting → Enable**, then
confirm the **Report a vulnerability** button appears under Security → Advisories.
It is not enabled merely by adding this policy. While the repository is private, the public
reporting route is not advertised as operational.

[GitHub's configuration instructions](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

## Data boundaries

The original record and indexes are local by default. Opting into Voyage sends indexed
passages and meaning-search queries to Voyage. An optional Anthropic distillation pass sends
selected text to Anthropic. Recalled text also enters the conversation with the AI client
that requested it. Credential scrubbing is a precaution, not a guarantee of anonymization.
The search-before-edit hook is a workflow check, not a security sandbox.
