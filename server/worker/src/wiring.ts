// The ONE place where the Worker imports job B's Gmail parser and meeting brief (BRIEF-D3 § 3.6, § 6.4).
// sync.ts takes them as parameters with these exact signatures, so tests inject fakes.
import { meetingBrief, validBrief } from '../../triage/brief.ts'
import { fromGmail } from '../../triage/gmail.ts'
import type { SyncModules } from './sync.ts'

export const realModules: SyncModules = { fromGmail, meetingBrief, validBrief }

/** The stored-brief check the calendar route applies before serving (the same one the sync used). */
export { validBrief }
