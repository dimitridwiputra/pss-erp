import { registryCatalog } from './catalog.generated';

export { registryCatalog } from './catalog.generated';

export function findErrorCode(code: string) {
  return registryCatalog.baseErrors.find((entry) => entry.code === code)
    ?? registryCatalog.domainErrors.find((entry) => entry.code === code);
}

export function findQueueSeed(code: string) {
  return registryCatalog.queueSeeds.find((entry) => entry.code === code);
}

export function findConfigurationSeed(keyExpression: string) {
  return registryCatalog.configurationSeeds.find((entry) => entry.keyExpression === keyExpression);
}

export function findStatusCopy(aggregateState: string) {
  return registryCatalog.statuses.find((entry) => entry.aggregateState === aggregateState);
}
