export { signupPlugin } from './plugin.js'
export { currentMode, decide, pruneSignupRequests, RECEIVED, submitSignup, verifySignup, type SignupInput, type SubmitResult, type VerifyInput } from './flow.js'
export { defaultEmails } from './emails.js'
export { SignupError } from './util.js'
export type {
  Check,
  CheckResult,
  Email,
  EmailContext,
  Emails,
  LimitKind,
  RateLimit,
  RequestStatus,
  SignupMode,
  SignupPluginOptions,
  SignupStatus,
} from './types.js'
export { MODES } from './types.js'
