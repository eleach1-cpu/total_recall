# Memory diagrams

## Continuing project work

Revised around the owner's September 19 clarification: session-to-session memory is the point,
not communication between two AI products. The MOS Lookup Tool example shows earlier lessons
being stored, recalled when a new work request arrives, and used before making changes.

This is a conceptual architecture with five nodes, not a database layout or a claim that a
particular MOS source has been verified. The three unlabeled arrows mean importing past work,
acting on the new request, and applying recovered context; their endpoints already explain these
steps. The labelled vertical arrow makes the cross-session connection explicit.

- [GitHub-ready SVG](my-long-term-memory.svg), with light/dark styles.
- [PNG copy](my-long-term-memory.png).
- [Interactive HTML](long-term-memory.html): open locally in a browser.
- [Editable specification](long-term-memory.architecture.json).

## Diagram receipt

```text
diagram_type: architecture
output: long-term-memory.html
specification_sha256: ac1327220d67a949392b5a547e7aa47fea3394f7817648f09d4162ed5c62adf1
artifact_sha256: 1eac4c570af0fefcf4bfd0209fe94eb0e8ffcf7b1a523c2d6f6f7d30ab6844f7
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 1
```

Browser evidence covers 1440×900, 1600×1000, 1920×1080 and 2048×1320. Light and dark endpoint
captures were generated. An image-capable review inspected the 1440×900 light and 2048×1320 dark
captures, plus the exported PNG. No clipped labels, crossed routes or cropped nodes were observed.
The SVG and PNG came from the delivered viewer's own export menu, not from screenshots of its controls.

## Session search and reasoning

The second diagram accompanies “You can ask it directly, too” in the main README. It follows an
article-history question through finding sessions, reading the exchanges, comparing the reasons
and later decisions, and answering with sources. Lanes distinguish your question, Total Recall's
retrieval work, and your AI's reasoning. Arrows need no extra labels because the node text names
each step. The first MOS/code-work diagram is unchanged.

- [GitHub-ready SVG](session-search-and-reasoning.svg), with light/dark styles.
- [PNG copy](session-search-and-reasoning.png).
- [Interactive HTML](session-search-and-reasoning.html).
- [Editable specification](session-search-and-reasoning.workflow.json).

```text
diagram_type: workflow
output: session-search-and-reasoning.html
specification_sha256: 25b981e116f565b390ff32904c1e0adfe97efd4f1cf80b2b627c88e5c0a7832d
artifact_sha256: 34a98e01eb2e312b277076c0cafc722f308a3cb6e3424b90493b1001174eec92
validation: 9/9 showcase, 0 errors, 0 warnings
browser_evidence: passed
visual_review: passed
correction_rounds: 2
```

Browser containment checked at 1440×900, 1600×1000, 1920×1080 and 2048×1320. The final
1440×900 light and 2048×1320 dark screenshots and exported PNG were visually inspected.
Labels fit, the three stages are distinct, and no content is clipped. SVG/PNG exports came
from the delivered viewer. No runtime code or tests changed for this diagram addition.
