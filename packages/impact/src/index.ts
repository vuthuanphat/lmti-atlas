export * from "./model.js";
export {
  initializeImpactStore, upgradeImpactStore, importImpactSnapshot, reviewImpactImport, recordImpactSourceStatus,
  readImpactSnapshot, lookupImpactEntity, getImpactEvidence, listImpactImports,
  readImpactImport, readImpactHistory, listImpactReportSummaries, type ImpactReportSummary
} from "./store.js";
export {
  sourceFreshness, buildImpactReport, createImpactReport, saveImpactReport,
  loadImpactReport, revalidateImpactReport, type ReportOptions
} from "./report.js";
export { createSyntheticImpactDemo } from "./demo.js";
export { compileMappedCodeSource, MAPPED_CODE_ADAPTER_VERSION, type CodeSourceMapping, type CodeSourceInput, type MappedCodeOptions } from "./code-source.js";
export { compileNativeProjectSource, validateNativeProjectSnapshot, nativeSourceId, nativeEntityId, NATIVE_SOURCE_ADAPTER_VERSION, type NativeProjectSnapshot } from "./native-source.js";
export * from "./review.js";
export * from "./mapping.js";
export { createImpactMappingOperator } from "./mapping-owner.js";
export {
  createImpactMappingReader, MAPPING_READ_LIMITS, mappingReadAuthorityFingerprint,
  mappingSourceContentFingerprint, mappingCurrentFingerprint,
  type MappingReadCode, type MappingReadQuery, type MappingReadOptions,
  type MappingReadObservationContext, type MappingSourceReadRequest,
  type MappingSourceReadResult, type MappingNativeReadRequest,
  type MappingReadObservers, type MappingReaderConfig, type ActiveMappingRow,
  type MappingCurrentRow, type MappingCurrentSnapshot, type MappingReader,
} from "./mapping-read.js";
