export { classifyInbound, extractEmailAddress, isValidSender } from "./classify.ts";
export { extractLead } from "./extract.ts";
export { applyEdit, buildDraft, scrubPii } from "./draft.ts";
export { processInboundMail, type PipelineDeps, type PipelineResult } from "./pipeline.ts";
export {
	handleTelegramCallback,
	handleEditMessage,
	recoverAfterCrash,
	makeCallbackData,
	type CallbackDeps,
	type CallbackResult,
} from "./callbacks.ts";
export { loadChecks, runDeterministicChecks, type ChecksConfig, type DraftCheckInput, type CheckFailure } from "./checks.ts";
export * as telegramCopy from "./telegram-copy.ts";
export { BUTTONS } from "./telegram-copy.ts";
