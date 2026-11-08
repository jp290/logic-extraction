# Example: cooking without recipes

A real conversation with the interview module about cooking "off the hand", and the
lens it produced.

| File | What it is |
|---|---|
| [`transcript.md`](transcript.md) | The interview (about 2,500 words), unedited |
| [`lens/index.md`](lens/index.md) | OKF bundle entry point |
| [`lens/logic-document.md`](lens/logic-document.md) | How this cook reasons: heat and fat first, roast before doneness, salt as a spotlight, honest attention |
| [`lens/knowledge-extract.md`](lens/knowledge-extract.md) | What they know: procedures, conditions, warnings |
| [`lens/understanding.md`](lens/understanding.md) | Why the moves work given that knowledge |
| [`lens/log.md`](lens/log.md) | Provenance and grounding summary |

Things worth noticing:

- The interviewer asks how the person thinks, not for steps, and the cook's own
  phrases carry the lens: "conviction in his pan", "honest attention", roast first
  and then go for doneness.
- The interviewee declined a question that left the domain ("let's get back to
  cooking, I don't wanna give you any information you don't explicitly need").
- **What the gates cannot catch.** The Logic Document explains the moves with
  "Maillard reaction", "caramelization" and a fat "Goldilocks zone", words that do
  not occur in the transcript; it states "other fats are inferior" where the cook
  said "beef tallow is best"; and it credits the cook with salt "like a spotlight",
  which was the interviewer's metaphor. Quote, number and entity checks pass over
  this kind of synthesis. It is the limitation the main README describes.
- Grounding numbers from `log.md` and the stored report: 48% of extracted entities
  traced to the transcript (25 of 52), and 11 of 13 checked knowledge claims
  verified, 2 corrected.

Provenance: produced on 2026-06-08 by the interview module with `deepseek-chat`,
before the quote gate covered every write path, so the layers have not been through
it. The bundle was exported with `src/okf.ts`; the canonical link points to a local
instance (`http://localhost:3471`).

To try it yourself: start the app, open **Interview**, and talk about something you
know well. Then open **Consult**, pick the new lens, and ask a question the
interview never covered.
