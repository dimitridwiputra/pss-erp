// `parseCommandInput` is canonical in `@pss/contracts`, beside `DomainError` which it throws. It
// lived here while this was the only domain that validated its own input; re-exporting keeps the
// import path inside this domain stable.
export { parseCommandInput } from '@pss/contracts';
