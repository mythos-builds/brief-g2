// Static « Other answers » (SCREENS.md § D″) for the screens on static data, day 1 only.
// The dataset has no alternatives yet: from D3 they come from the triage layer (app/server/triage, job B),
// in the same model answer as the draft. Marco's four are SCREENS.md's own; the others are fictional demo text.
// Order = intent: yes · no · later · a question.

export const STATIC_ALTS: Record<string, string[]> = {
  marco: [
    'Yes, I can cover Friday 6 am.',
    "No, I can't this Friday. Sorry.",
    "Maybe. I'll confirm by 3 pm today.",
    'Which line, and until what time?',
  ],
  priya: [
    'Yes, I can be there at 4:30 today.',
    "No, not today. I can come tomorrow at 7.",
    "Later today. I'll call you by 1 pm.",
    'Which alarm code shows on the HMI?',
  ],
  sam: [
    'Yes, open gate 3 at 6:30.',
    'No, keep gate 3 closed until 7, please.',
    "Later. I'll confirm by 5 pm.",
    'Who will be at gate 3 at 6:30?',
  ],
}
