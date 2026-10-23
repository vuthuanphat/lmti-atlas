/** Versioned UI DTOs. Native/Python owners retain domain validation and storage. */
export type ClientId = 'codex' | 'cursor';
export type ProjectId = string; // Resolved through the trusted project library.
export type Revision = number; // Integer 0..Number.MAX_SAFE_INTEGER; validate at every boundary.
export type OpaqueId = string; // Broker-generated random ID; never an authority-bearing path.
export type UtcTimestamp = string;
export type Capability =
  | 'profile.read' | 'profile.update' | 'client.preview' | 'client.apply'
  | 'client.restore' | 'client.export' | 'connection.check' | 'project.operations'
  | 'logical.hierarchy' | 'physical.hierarchy';
export interface ProjectSummary {
  id: ProjectId;
  name: string;
  projectRevision: Revision;
  profileRevision: Revision;
  linkedRoot: boolean;
  capabilities: Capability[];
}
export interface Page<T> {
  items: T[];
  nextCursor: OpaqueId | null; // Session/scope/filter/revision-bound; TTL required.
}
interface ServerBase {
  id: string; // Lowercase bounded key, native validation authoritative.
  label: string;
  enabled: boolean;
}
export type McpServerDto =
  | (ServerBase & { transport: 'lmti_local'; auth: 'none'; site: string })
  | (ServerBase & { transport: 'remote_https'; auth: 'client_oauth'; endpoint: string; privateEndpoint: boolean });
export interface ProfileDto {
  projectId: ProjectId;
  revision: Revision;
  servers: McpServerDto[];
}
export interface UpdateProfileRequest {
  expectedRevision: Revision;
  servers: McpServerDto[]; // Complete replacement; <=32 entries, no unknown fields.
}
export type ConfigState = 'not_applied' | 'applied' | 'update_pending' | 'recovery_required' | 'review_required' | 'unavailable';
export interface ClientStatusDto {
  client: ClientId;
  configuration: ConfigState;
  appliedRevision: Revision | null;
  checkedAt: UtcTimestamp;
  clientUse: 'not_verified' | 'verified'; // Verified requires retained actual-client evidence.
  evidenceId: OpaqueId | null;
  canRestore: boolean;
  capabilities: Capability[];
}
export interface CreatePreviewRequest {
  expectedProfileRevision: Revision;
  operation: 'apply' | 'restore';
}
export interface ClientPreviewDto {
  id: OpaqueId;
  projectId: ProjectId;
  client: ClientId;
  operation: 'apply' | 'restore';
  profileRevision: Revision;
  expiresAt: UtcTimestamp;
  changes: { added: string[]; updated: string[]; removed: string[] } | null;
  preservesUnmanagedServers: boolean;
  protectedRecovery: boolean;
  // Added only for apply. Owner-generated managed config; never existing raw config.
  generatedConfig: { format: 'toml' | 'json'; content: string } | null;
}
export interface CommitPreviewRequest { previewId: OpaqueId; }
export interface CommitResultDto {
  operationId: OpaqueId;
  client: ClientId;
  outcome: 'applied' | 'restored' | 'pending' | 'unknown';
  status: ClientStatusDto | null;
}
export interface ManagedExportDto {
  projectId: ProjectId;
  client: ClientId;
  profileRevision: Revision;
  format: 'toml' | 'json';
  filename: string;
  content: string; // Managed configuration only, explicitly requested by operator.
}
export interface ConnectionCheckDto {
  serverId: string;
  kind: 'local_handshake'; // Remote checking not supported in the first live slice.
  state: 'ok' | 'failed' | 'not_supported';
  checkedAt: UtcTimestamp;
  toolNames: string[];
  unknowns: string[];
}
export type ErrorCode =
  | 'UNAUTHENTICATED' | 'SESSION_EXPIRED' | 'ORIGIN_REJECTED' | 'SCOPE_DENIED'
  | 'INVALID_INPUT' | 'REVISION_CONFLICT' | 'PREVIEW_EXPIRED' | 'CONFIG_CHANGED'
  | 'RECOVERY_REQUIRED' | 'UNMANAGED_COLLISION' | 'OWNED_CONFIG_DRIFT'
  | 'NOT_SUPPORTED' | 'OWNER_UNAVAILABLE' | 'LIMIT_EXCEEDED' | 'BUSY';
export type ApiResult<T> =
  | { apiVersion: 1; requestId: OpaqueId; ok: true; data: T }
  | { apiVersion: 1; requestId: OpaqueId; ok: false; error: { code: ErrorCode; message: string; retryable: boolean } };

/** Public logical hierarchy only; native paths, identities and review pins stay private. */
export type LogicalHierarchyPrivacy = 'public' | 'internal';
export interface LogicalSubsystemDto {
  readonly id: string;
  readonly label: string;
  readonly parentSubsystemId: string; // Empty string means project root.
  readonly privacy: LogicalHierarchyPrivacy; // Stored, not inherited classification.
}
export interface LogicalComponentDto {
  readonly id: string;
  readonly label: string;
  readonly repositoryId: string;
  readonly kind: 'firmware' | 'gateway' | 'backend' | 'desktop' | 'driver' | 'library';
  readonly privacy: LogicalHierarchyPrivacy;
}
export interface LogicalMembershipDto {
  readonly componentId: string;
  readonly subsystemId: string;
}
export type LogicalHierarchyChangeDto =
  | { readonly kind: 'add_subsystem'; readonly desired: LogicalSubsystemDto }
  | { readonly kind: 'rename_subsystem'; readonly expected: LogicalSubsystemDto; readonly desiredLabel: string }
  | { readonly kind: 'reparent_subsystem'; readonly expected: LogicalSubsystemDto; readonly desiredParentId: string }
  | { readonly kind: 'set_component_membership'; readonly expectedComponent: LogicalComponentDto;
      readonly expected: LogicalMembershipDto | null; readonly desiredSubsystemId: string | null }
  | { readonly kind: 'retire_empty_subsystem'; readonly expected: LogicalSubsystemDto };
export interface LogicalHierarchyProposalDto {
  readonly projectId: ProjectId;
  readonly expectedRevision: Revision;
  readonly changes: readonly LogicalHierarchyChangeDto[]; // 1–32, from one original state.
}
export interface LogicalHierarchyGrantDto {
  readonly projectId: ProjectId;
  readonly allowInternal: boolean;
}
export interface LogicalHierarchyScopesDto { readonly projects: readonly LogicalHierarchyGrantDto[]; }
export interface LogicalHierarchyStateDto {
  readonly projectId: ProjectId;
  readonly revision: Revision;
  readonly subsystems: readonly {
    readonly value: LogicalSubsystemDto; readonly ancestors: readonly string[];
    readonly classification: LogicalHierarchyPrivacy;
  }[];
  readonly components: readonly {
    readonly value: LogicalComponentDto; readonly membership: LogicalMembershipDto | null;
    readonly ancestors: readonly string[]; readonly classification: LogicalHierarchyPrivacy;
  }[];
}
export interface LogicalHierarchyDiffDto {
  readonly subsystems: readonly {
    readonly id: string; readonly before: LogicalSubsystemDto | null; readonly after: LogicalSubsystemDto | null;
  }[];
  readonly memberships: readonly {
    readonly componentId: string; readonly before: LogicalMembershipDto | null; readonly after: LogicalMembershipDto | null;
  }[];
  readonly affected: readonly {
    readonly kind: 'subsystem' | 'component'; readonly id: string;
    readonly beforeClassification: LogicalHierarchyPrivacy | null;
    readonly afterClassification: LogicalHierarchyPrivacy | null;
    readonly beforeAncestors: readonly string[]; readonly afterAncestors: readonly string[];
  }[];
}
export interface LogicalHierarchyPreviewDto {
  readonly id: OpaqueId; readonly projectId: ProjectId; readonly revision: Revision;
  readonly expiresAt: UtcTimestamp; readonly diff: LogicalHierarchyDiffDto;
}
export interface LogicalHierarchyCommitResultDto {
  readonly operationId: OpaqueId; readonly action: 'logical-hierarchy-commit';
  readonly outcome: 'pending' | 'confirmed' | 'refused' | 'unknown';
  readonly code: ErrorCode | null;
  readonly summary: { readonly projectId: ProjectId; readonly previousRevision: Revision; readonly revision: Revision } | null;
}
export interface LogicalHierarchyJobDto {
  readonly operationId: OpaqueId; readonly state: 'pending' | 'succeeded' | 'failed' | 'unknown';
  readonly result: LogicalHierarchyCommitResultDto | null; readonly errorCode: ErrorCode | null;
}

export type PhysicalHierarchyPrivacy = 'public' | 'internal';
export interface PhysicalSiteDto { readonly id:string; readonly label:string; readonly privacy:PhysicalHierarchyPrivacy; }
export interface PhysicalAreaDto extends PhysicalSiteDto { readonly siteId:string; readonly parentAreaId:string; }
export interface PhysicalEnvironmentDto extends PhysicalSiteDto {}
export interface PhysicalAssetAnchorDto extends PhysicalSiteDto {
  readonly site:string; readonly kind:'machine'|'gateway'|'broker'|'service'|'sensor';
}
export interface PhysicalAssetPlacementDto {
  readonly assetId:string; readonly areaId:string; readonly parentAssetId:string; readonly environmentId:string;
  readonly role:'host'|'gateway'|'device'|null;
}
export interface PhysicalHierarchyPathDto {
  readonly siteId:string; readonly areaAncestors:readonly string[]; readonly assetAncestors:readonly string[]; readonly environmentId:string;
}
export type PhysicalHierarchyChangeDto =
  | {readonly kind:'add_site'; readonly desired:PhysicalSiteDto}
  | {readonly kind:'rename_site'; readonly expected:PhysicalSiteDto; readonly desiredLabel:string}
  | {readonly kind:'retire_empty_site'; readonly expected:PhysicalSiteDto}
  | {readonly kind:'add_area'; readonly desired:PhysicalAreaDto}
  | {readonly kind:'rename_area'; readonly expected:PhysicalAreaDto; readonly desiredLabel:string}
  | {readonly kind:'reparent_area'; readonly expected:PhysicalAreaDto; readonly desiredParentId:string}
  | {readonly kind:'retire_empty_area'; readonly expected:PhysicalAreaDto}
  | {readonly kind:'add_environment'; readonly desired:PhysicalEnvironmentDto}
  | {readonly kind:'rename_environment'; readonly expected:PhysicalEnvironmentDto; readonly desiredLabel:string}
  | {readonly kind:'retire_empty_environment'; readonly expected:PhysicalEnvironmentDto}
  | {readonly kind:'set_asset_placement'; readonly expectedAsset:PhysicalAssetAnchorDto;
      readonly expected:PhysicalAssetPlacementDto|null; readonly desired:PhysicalAssetPlacementDto|null};
export interface PhysicalHierarchyProposalDto {
  readonly projectId:ProjectId; readonly expectedRevision:Revision; readonly changes:readonly PhysicalHierarchyChangeDto[];
}
export interface PhysicalHierarchyGrantDto { readonly projectId:ProjectId; readonly allowInternal:boolean; }
export interface PhysicalHierarchyScopesDto { readonly projects:readonly PhysicalHierarchyGrantDto[]; }
export interface PhysicalHierarchyStateDto {
  readonly projectId:ProjectId; readonly revision:Revision;
  readonly sites:readonly {readonly value:PhysicalSiteDto; readonly classification:PhysicalHierarchyPrivacy}[];
  readonly areas:readonly {readonly value:PhysicalAreaDto; readonly ancestors:readonly string[]; readonly classification:PhysicalHierarchyPrivacy}[];
  readonly environments:readonly {readonly value:PhysicalEnvironmentDto; readonly classification:PhysicalHierarchyPrivacy}[];
  readonly assets:readonly {readonly value:PhysicalAssetAnchorDto; readonly placement:PhysicalAssetPlacementDto|null;
    readonly path:PhysicalHierarchyPathDto; readonly classification:PhysicalHierarchyPrivacy}[];
}
export interface PhysicalHierarchyDiffDto {
  readonly sites:readonly {readonly id:string; readonly before:PhysicalSiteDto|null; readonly after:PhysicalSiteDto|null}[];
  readonly areas:readonly {readonly id:string; readonly before:PhysicalAreaDto|null; readonly after:PhysicalAreaDto|null}[];
  readonly environments:readonly {readonly id:string; readonly before:PhysicalEnvironmentDto|null; readonly after:PhysicalEnvironmentDto|null}[];
  readonly placements:readonly {readonly assetId:string; readonly before:PhysicalAssetPlacementDto|null; readonly after:PhysicalAssetPlacementDto|null}[];
  readonly affected:readonly {
    readonly kind:'site'|'area'|'environment'|'asset'; readonly id:string;
    readonly beforeClassification:PhysicalHierarchyPrivacy|null; readonly afterClassification:PhysicalHierarchyPrivacy|null;
    readonly beforePath:PhysicalHierarchyPathDto; readonly afterPath:PhysicalHierarchyPathDto;
  }[];
}
export interface PhysicalHierarchyPreviewDto {
  readonly id:OpaqueId; readonly projectId:ProjectId; readonly revision:Revision;
  readonly expiresAt:UtcTimestamp; readonly diff:PhysicalHierarchyDiffDto;
}
export interface PhysicalHierarchyCommitResultDto {
  readonly operationId:OpaqueId; readonly action:'physical-hierarchy-commit';
  readonly outcome:'pending'|'confirmed'|'refused'|'unknown'; readonly code:ErrorCode|null;
  readonly summary:{readonly projectId:ProjectId; readonly previousRevision:Revision; readonly revision:Revision}|null;
}
export interface PhysicalHierarchyJobDto {
  readonly operationId:OpaqueId; readonly state:'pending'|'succeeded'|'failed'|'unknown';
  readonly result:PhysicalHierarchyCommitResultDto|null; readonly errorCode:ErrorCode|null;
}
export interface LegacyRecoverySummaryDto {
  readonly projectId: ProjectId; readonly projectRevision: Revision; readonly profileRevision: Revision;
  readonly clients: readonly {
    readonly client: ClientId; readonly state: 'not_applied' | 'configured' | 'recovery_required';
  }[];
}
export interface HierarchyRecoverySummaryDto { readonly projectId: ProjectId; readonly projectRevision: Revision; }
export interface PhysicalHierarchyRecoverySummaryDto { readonly projectId:ProjectId; readonly projectRevision:Revision; }
export type RecoveryAffectedScopeDto =
    | { readonly kind: 'library_management'; readonly action: 'create' | 'register' | 'link' | 'pin' | 'forget';
        readonly projectId: ProjectId; readonly subjects: number }
  | { readonly kind: 'legacy'; readonly action: 'profile_save' | 'desired_proposal' | 'project_content' | 'client_apply' | 'client_restore';
      readonly projectId: ProjectId; readonly subjects: number }
  | { readonly kind: 'logical_hierarchy'; readonly action: 'logical-hierarchy-commit';
      readonly projectId: ProjectId; readonly subjects: number }
  | { readonly kind: 'physical_hierarchy'; readonly action: 'physical-hierarchy-commit';
      readonly projectId: ProjectId; readonly subjects: number }
  | { readonly kind: 'project_operations'; readonly action: 'copy-prepare' | 'activation-prepare' | 'activation-activate' | 'activation-abandon';
      readonly projectId: ProjectId; readonly subjects: number }
  | { readonly kind: 'project_operations'; readonly action: 'library-upgrade-v1' | 'library-upgrade-v2';
      readonly projectId: null; readonly subjects: number };
export interface RecoveryCoverageDto {
  readonly retainedSubjects: number; // 0–32 retained records, not outcomes or unique physical targets.
  readonly affectedScopes: readonly RecoveryAffectedScopeDto[];
  readonly librarySchema: 1 | 2 | 3 | null; // Null means no schema summary was supplied.
}
interface CommonRecoveryPreviewBase {
  readonly id: OpaqueId; readonly expiresAt: UtcTimestamp;
  readonly items: readonly LegacyRecoverySummaryDto[]; // Repeated project IDs remain separate observations.
  readonly priorOutcome: 'unknown';
}
export type CommonRecoveryPreviewDto =
  | (CommonRecoveryPreviewBase & { readonly hierarchyItems?: never; readonly physicalHierarchyItems?: never; readonly coverage?: never })
  | (CommonRecoveryPreviewBase & {
      readonly hierarchyItems: readonly HierarchyRecoverySummaryDto[];
      readonly physicalHierarchyItems?: never;
      readonly coverage: RecoveryCoverageDto;
    })
  | (CommonRecoveryPreviewBase & {
      readonly hierarchyItems: readonly HierarchyRecoverySummaryDto[];
      readonly physicalHierarchyItems: readonly PhysicalHierarchyRecoverySummaryDto[];
      readonly coverage: RecoveryCoverageDto;
    });
export interface CommonRecoveryAcknowledgmentDto {
  readonly reviewed: true; readonly priorOutcome: 'unknown'; readonly freshReviewRequired: true;
}
