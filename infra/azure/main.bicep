targetScope = 'subscription'
@minLength(3)
@maxLength(8)
param prefix string
@allowed(['staging', 'production'])
param stage string
param location string
param cellId string = 'cell-1'
param publicHostname string = ''
@secure()
param accountAdministratorPassword string
@secure()
param cellAdministratorPassword string
param registryName string
param registryResourceGroup string
param registrySubscriptionId string = subscription().subscriptionId
// Explicitly separate paid infrastructure provisioning from application activation.
param activateRuntime bool = false
param activateMigrationJobs bool = false
param activateBootstrapJobs bool = false
param activateMaintenanceJobs bool = false
param activateEdge bool = false
param enablePreparationWorker bool = false
param enableIndexingWorker bool = false
// Enable only after an owning native Intelligence events entrypoint is published and image-qualified.
param enableIntelligenceEvents bool = false
param enableCaptureExtractionWorker bool = false
param runtimeConfig object = {}
param migrationConfig object = {}
param bootstrapConfig object = {}
param primaryZone string = '1'
param standbyZone string = '2'
param pgSku string = 'Standard_D2ds_v5'

var globalName = '${prefix}-${stage}-g'
var cellName = '${prefix}-${stage}-c'
var globalRuntimeName = '${prefix}-${stage == 'staging' ? 'stg' : 'prd'}-g'
var cellRuntimeName = '${prefix}-${stage == 'staging' ? 'stg' : 'prd'}-c'
resource globalGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = { name: '${globalName}-rg', location: location, tags: { product: 'visualsprint', stage: stage, boundary: 'global' } }
resource cellGroup 'Microsoft.Resources/resourceGroups@2024-03-01' = { name: '${cellName}-rg', location: location, tags: { product: 'visualsprint', stage: stage, boundary: cellId } }
module network './modules/network.bicep' = {
  name: 'regional-network'
  scope: globalGroup
  params: { name: '${prefix}-${stage}-network', location: location }
}
module account './modules/foundation.bicep' = {
  name: 'account-foundation'
  scope: globalGroup
  params: {
    name: globalName, location: location, appsSubnetId: network.outputs.accountAppsSubnetId, postgresSubnetId: network.outputs.accountPgSubnetId
    postgresDnsId: network.outputs.postgresDnsId, endpointsSubnetId: network.outputs.endpointsSubnetId, vnetId: network.outputs.vnetId, vaultDnsId: network.outputs.vaultDnsId
    administratorPassword: accountAdministratorPassword, databases: ['account'], primaryZone: primaryZone, standbyZone: standbyZone, pgSku: pgSku
  }
}
module cell './modules/foundation.bicep' = {
  name: 'cell-foundation'
  scope: cellGroup
  params: {
    name: cellName, location: location, appsSubnetId: network.outputs.cellAppsSubnetId, postgresSubnetId: network.outputs.cellPgSubnetId
    postgresDnsId: network.outputs.postgresDnsId, endpointsSubnetId: network.outputs.endpointsSubnetId, vnetId: network.outputs.vnetId, vaultDnsId: network.outputs.vaultDnsId
    administratorPassword: cellAdministratorPassword, databases: ['workspace', 'ingest', 'integration', 'intelligence', 'workflow', 'notification', 'reporting', 'authz_application', 'authz']
    primaryZone: primaryZone, standbyZone: standbyZone, pgSku: pgSku
  }
}
module dependencies './modules/cell-resources.bicep' = {
  name: 'regional-dependencies'
  scope: cellGroup
  params: { name: cellName, location: location, egressIp: network.outputs.egressIp, endpointsSubnetId: network.outputs.endpointsSubnetId, blobDnsId: network.outputs.blobDnsId, pubsubDnsId: network.outputs.pubsubDnsId, enableCaptureExtraction: enableCaptureExtractionWorker }
}

var cellServices = ['workspace', 'ingest', 'integration', 'intelligence', 'workflow', 'notification', 'reporting', 'authz']
var cellOrigins = toObject(cellServices, service => service, service => 'https://${cellRuntimeName}-${service}.${cell.outputs.defaultDomain}')
var accountOrigin = 'https://${globalRuntimeName}-account.${account.outputs.defaultDomain}'
var defaults = {
  NODE_ENV: 'production'
  PORT: '8080'
  ACCOUNT_INTERNAL_URL: accountOrigin
  WORKSPACE_INTERNAL_URL: cellOrigins.workspace
  INGEST_INTERNAL_URL: cellOrigins.ingest
  INTEGRATION_INTERNAL_URL: cellOrigins.integration
  INTELLIGENCE_INTERNAL_URL: cellOrigins.intelligence
  WORKFLOW_INTERNAL_URL: cellOrigins.workflow
  AUTHZ_INTERNAL_URL: cellOrigins.authz
  OPENFGA_URL: 'https://${cellRuntimeName}-openfga.${cell.outputs.defaultDomain}'
  SERVICE_BUS_NAMESPACE: dependencies.outputs.namespaceHost
}
var services = ['account', 'gateway', 'web', 'openfga', 'workspace', 'authz', 'ingest', 'integration', 'intelligence', 'workflow', 'reporting', 'notification']
module apis './modules/runtime.bicep' = [for service in services: if (activateRuntime) {
  name: '${service}-api'
  scope: resourceGroup(service == 'account' ? globalGroup.name : cellGroup.name)
  params: {
    name: '${service == 'account' ? globalRuntimeName : cellRuntimeName}-${service}', location: location
    environmentId: service == 'account' ? account.outputs.environmentId : cell.outputs.environmentId
    vaultName: service == 'account' ? account.outputs.vaultName : cell.outputs.vaultName
    registryName: registryName, registryResourceGroup: registryResourceGroup, registrySubscriptionId: registrySubscriptionId
    image: runtimeConfig[service].image, mode: 'api'
    command: service == 'web' ? ['node', 'web-server.mjs'] : service == 'openfga' ? ['/openfga', 'run'] : ['node', 'dist/main.mjs']
    env: concat(map(items(union(defaults, service == 'gateway' ? { CELL_ROUTES: string({ '${cellId}': { workspace: cellOrigins.workspace, ingest: cellOrigins.ingest, integration: cellOrigins.integration, intelligence: cellOrigins.intelligence, workflow: cellOrigins.workflow, reporting: cellOrigins.reporting, notification: cellOrigins.notification } }) } : {}, service == 'account' ? { DEFAULT_CELL_ID: cellId } : {})), entry => { name: entry.key, value: entry.value }), runtimeConfig[service].env)
    secretBindings: runtimeConfig[service].secrets
    minReplicas: contains(['ingest', 'gateway', 'account'], service) ? 2 : 1, maxReplicas: service == 'ingest' ? 5 : 3
    healthPath: service == 'openfga' ? '/healthz' : '/health'
  }
}]
var workers = [
  { name: 'workspace-worker', service: 'workspace', entry: 'worker', extra: {} }
  { name: 'workspace-events', service: 'workspace', entry: 'events', extra: {} }
  { name: 'ingest-worker', service: 'ingest', entry: 'worker', extra: {} }
  { name: 'ingest-events', service: 'ingest', entry: 'events', extra: { INGEST_EVENT_WORKER_KIND: 'publisher' } }
  { name: 'ingest-processing', service: 'ingest', entry: 'events', extra: { INGEST_EVENT_WORKER_KIND: 'processing' } }
  { name: 'integration-worker', service: 'integration', entry: 'worker', extra: {} }
  { name: 'intelligence-interactive', service: 'intelligence', entry: 'worker', extra: { INTELLIGENCE_WORKER_KIND: 'interactive' } }
  { name: 'intelligence-preparation', service: 'intelligence', entry: 'worker', extra: { INTELLIGENCE_WORKER_KIND: 'preparation' } }
  { name: 'intelligence-indexing', service: 'intelligence', entry: 'worker', extra: { INTELLIGENCE_WORKER_KIND: 'indexing' } }
  { name: 'intelligence-extraction', service: 'intelligence', entry: 'worker', extra: { INTELLIGENCE_WORKER_KIND: 'extraction' } }
  { name: 'workflow-worker', service: 'workflow', entry: 'worker', extra: {} }
  { name: 'workflow-events', service: 'workflow', entry: 'events', extra: {} }
  { name: 'reporting-worker', service: 'reporting', entry: 'worker', extra: {} }
  { name: 'notification-worker', service: 'notification', entry: 'worker', extra: {} }
  { name: 'notification-events', service: 'notification', entry: 'events', extra: {} }
  { name: 'intelligence-events', service: 'intelligence', entry: 'events', extra: {} }
]
// Preparation/indexing remain independently controlled by their native flags, never a fixture fallback.
module workerApps './modules/runtime.bicep' = [for worker in workers: if (activateRuntime && (worker.name != 'intelligence-preparation' || enablePreparationWorker) && (worker.name != 'intelligence-indexing' || enableIndexingWorker) && (worker.name != 'intelligence-events' || enableIntelligenceEvents) && (!contains(['intelligence-extraction', 'ingest-processing'], worker.name) || enableCaptureExtractionWorker)) {
  name: worker.name
  scope: cellGroup
  params: {
    name: '${cellRuntimeName}-${replace(replace(replace(replace(worker.name, 'intelligence', 'ai'), 'notification', 'notify'), 'integration', 'connect'), 'workspace', 'ws')}', location: location, environmentId: cell.outputs.environmentId, vaultName: cell.outputs.vaultName
    registryName: registryName, registryResourceGroup: registryResourceGroup, registrySubscriptionId: registrySubscriptionId
    image: runtimeConfig[worker.service].image, mode: 'worker', command: ['node', 'dist/${worker.entry}.mjs']
    env: concat(map(items(defaults), entry => { name: entry.key, value: entry.value }), filter(runtimeConfig[worker.service].env, entry => !contains(worker.extra, entry.name)), map(items(worker.extra), entry => { name: entry.key, value: entry.value }))
    secretBindings: worker.name == 'ingest-processing' ? filter(runtimeConfig[worker.service].secrets, binding => contains(['INGEST_DATABASE_URL', 'SERVICE_PRIVATE_JWK'], binding.env)) : runtimeConfig[worker.service].secrets
    minReplicas: 1, maxReplicas: 1
  }
}]
var workerNames = map(workers, worker => worker.name)
var publishers = ['workspace', 'ingest', 'workflow', 'notification', 'intelligence']
module eventSender './modules/event-access.bicep' = [for publisher in publishers: if (activateRuntime && (publisher != 'intelligence' || enableIntelligenceEvents)) {
  name: '${publisher}-event-sender'
  scope: cellGroup
  params: { namespaceName: '${cellName}-bus', topicName: 'vs-${publisher}', principalId: workerApps[indexOf(workerNames, '${publisher}-events')]!.outputs.principalId }
}]
module eventReceiver './modules/event-access.bicep' = [for producer in ['ingest', 'workflow', 'intelligence']: if (activateRuntime) {
  name: '${producer}-notification-reader'
  scope: cellGroup
  params: { namespaceName: '${cellName}-bus', topicName: 'vs-${producer}', principalId: workerApps[indexOf(workerNames, 'notification-events')]!.outputs.principalId, receiver: true }
}]
var migrationServices = ['account', 'workspace', 'authz', 'ingest', 'integration', 'intelligence', 'workflow', 'reporting', 'notification', 'openfga']
module extractionReceiver './modules/event-access.bicep' = if (activateRuntime && enableIntelligenceEvents && enableCaptureExtractionWorker) {
  name: 'ingest-extraction-reader'
  scope: cellGroup
  params: { namespaceName: '${cellName}-bus', topicName: 'vs-ingest', subscriptionName: 'capture-extraction-v1', principalId: workerApps[indexOf(workerNames, 'intelligence-events')]!.outputs.principalId, receiver: true }
}
module migrations './modules/runtime.bicep' = [for service in migrationServices: if (activateMigrationJobs) {
  name: '${service}-migration'
  scope: resourceGroup(service == 'account' ? globalGroup.name : cellGroup.name)
  params: {
    name: '${service == 'account' ? globalRuntimeName : cellRuntimeName}-${replace(replace(replace(service, 'intelligence', 'ai'), 'notification', 'notify'), 'integration', 'connect')}-migrate', location: location
    environmentId: service == 'account' ? account.outputs.environmentId : cell.outputs.environmentId
    vaultName: service == 'account' ? account.outputs.vaultName : cell.outputs.vaultName
    registryName: registryName, registryResourceGroup: registryResourceGroup, registrySubscriptionId: registrySubscriptionId
    image: migrationConfig[service].image, mode: 'job', command: service == 'openfga' ? ['/openfga', 'migrate'] : ['node', 'dist/migrate.mjs']
    env: migrationConfig[service].env, secretBindings: migrationConfig[service].secrets
  }
}]
var bootstrapTargets = ['account', 'workspace', 'ingest', 'integration', 'intelligence', 'workflow', 'notification', 'reporting', 'authz_application', 'authz']
module bootstrap './modules/runtime.bicep' = [for db in bootstrapTargets: if (activateBootstrapJobs) {
  name: '${db}-role-bootstrap'
  scope: resourceGroup(db == 'account' ? globalGroup.name : cellGroup.name)
  params: {
    name: '${db == 'account' ? globalRuntimeName : cellRuntimeName}-${replace(replace(replace(db, 'authz_application', 'authz-app'), 'intelligence', 'ai'), 'notification', 'notify')}-roles', location: location
    environmentId: db == 'account' ? account.outputs.environmentId : cell.outputs.environmentId
    vaultName: db == 'account' ? account.outputs.vaultName : cell.outputs.vaultName
    registryName: registryName, registryResourceGroup: registryResourceGroup, registrySubscriptionId: registrySubscriptionId
    image: bootstrapConfig[db].image, mode: 'job', command: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '/bootstrap.sql']
    env: concat([{ name: 'PGHOST', value: db == 'account' ? account.outputs.postgresHost : cell.outputs.postgresHost }, { name: 'PGDATABASE', value: 'postgres' }, { name: 'PGUSER', value: 'vs_provisioner' }, { name: 'PGSSLMODE', value: 'verify-full' }, { name: 'PGSSLROOTCERT', value: 'system' }, { name: 'DB_NAME', value: db }], bootstrapConfig[db].env)
    secretBindings: bootstrapConfig[db].secrets
  }
}]
var maintenanceTasks = [{ name: 'vector', db: 'intelligence', script: 'vector' }, { name: 'fga-grants', db: 'authz', script: 'openfga-grants' }]
module maintenance './modules/runtime.bicep' = [for task in maintenanceTasks: if (activateMaintenanceJobs) {
  name: '${task.name}-maintenance'
  scope: cellGroup
  params: {
    name: '${cellRuntimeName}-${task.name}', location: location, environmentId: cell.outputs.environmentId, vaultName: cell.outputs.vaultName
    registryName: registryName, registryResourceGroup: registryResourceGroup, registrySubscriptionId: registrySubscriptionId
    image: bootstrapConfig[task.db].image, mode: 'job', command: ['psql', '-X', '-v', 'ON_ERROR_STOP=1', '-f', '/${task.script}.sql']
    env: [{ name: 'PGHOST', value: cell.outputs.postgresHost }, { name: 'PGDATABASE', value: 'postgres' }, { name: 'PGUSER', value: 'vs_provisioner' }, { name: 'PGSSLMODE', value: 'verify-full' }, { name: 'PGSSLROOTCERT', value: 'system' }]
    secretBindings: filter(bootstrapConfig[task.db].secrets, binding => binding.env == 'PGPASSWORD')
  }
}]
module edge './modules/edge.bicep' = if (activateRuntime && activateEdge) {
  name: 'front-door'
  scope: globalGroup
  params: { name: '${prefix}-${stage}-edge', originHost: '${cellRuntimeName}-gateway.${cell.outputs.defaultDomain}', frontendHost: '${cellRuntimeName}-web.${cell.outputs.defaultDomain}', environmentId: cell.outputs.environmentId, location: location, publicHostname: publicHostname }
  dependsOn: [apis]
}
output globalResourceGroup string = globalGroup.name
output cellResourceGroup string = cellGroup.name
output accountOrigin string = accountOrigin
output cellOrigins object = cellOrigins
output accountPostgresHost string = account.outputs.postgresHost
output cellPostgresHost string = cell.outputs.postgresHost
output egressIp string = network.outputs.egressIp
output accountVaultUri string = account.outputs.vaultUri
output cellVaultUri string = cell.outputs.vaultUri
output runtimeActivated bool = activateRuntime
