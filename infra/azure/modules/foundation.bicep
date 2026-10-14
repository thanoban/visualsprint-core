param name string
param location string
param appsSubnetId string
param postgresSubnetId string
param postgresDnsId string
param endpointsSubnetId string
param vnetId string
param vaultDnsId string
@secure()
param administratorPassword string
param databases array
param pgSku string = 'Standard_D2ds_v5'
param primaryZone string = '1'
param standbyZone string = '2'

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${name}-logs'
  location: location
  properties: { retentionInDays: 30, sku: { name: 'PerGB2018' }, publicNetworkAccessForIngestion: 'Enabled', publicNetworkAccessForQuery: 'Enabled', workspaceCapping: { dailyQuotaGb: 2 } }
}
resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${name}-insights'
  location: location
  kind: 'web'
  properties: { Application_Type: 'web', WorkspaceResourceId: logs.id, RetentionInDays: 30, DisableLocalAuth: true }
}
resource environment 'Microsoft.App/managedEnvironments@2025-07-01' = {
  name: '${name}-apps'
  location: location
  properties: {
    publicNetworkAccess: 'Disabled'
    zoneRedundant: true
    vnetConfiguration: { infrastructureSubnetId: appsSubnetId, internal: true }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
    appLogsConfiguration: { destination: 'azure-monitor' }
    peerAuthentication: { mtls: { enabled: true } }
    peerTrafficConfiguration: { encryption: { enabled: true } }
  }
}
module appDns './app-dns.bicep' = {
  name: 'private-app-dns'
  params: { domain: environment.properties.defaultDomain, privateIp: environment.properties.staticIp, vnetId: vnetId }
}
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'environment'
  scope: environment
  properties: { workspaceId: logs.id, logs: [{ category: 'ContainerAppConsoleLogs', enabled: true }, { category: 'ContainerAppSystemLogs', enabled: true }] }
}
resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${name}-kv'
  location: location
  properties: { tenantId: tenant().tenantId, sku: { family: 'A', name: 'standard' }, enableRbacAuthorization: true, enableSoftDelete: true, softDeleteRetentionInDays: 90, enablePurgeProtection: true, publicNetworkAccess: 'Disabled', networkAcls: { bypass: 'None', defaultAction: 'Deny' } }
}
module vaultEndpoint './private-endpoint.bicep' = {
  name: 'vault-endpoint'
  params: { name: '${name}-vault-pe', location: location, subnetId: endpointsSubnetId, targetId: vault.id, groupId: 'vault', dnsZoneId: vaultDnsId }
}
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${name}-pg'
  location: location
  sku: { name: pgSku, tier: 'GeneralPurpose' }
  properties: {
    version: '17'
    administratorLogin: 'vs_provisioner'
    administratorLoginPassword: administratorPassword
    availabilityZone: primaryZone
    highAvailability: { mode: 'ZoneRedundant', standbyAvailabilityZone: standbyZone }
    backup: { backupRetentionDays: 14, geoRedundantBackup: 'Disabled' }
    storage: { storageSizeGB: 128, autoGrow: 'Enabled' }
    authConfig: { activeDirectoryAuth: 'Disabled', passwordAuth: 'Enabled' }
    network: { delegatedSubnetResourceId: postgresSubnetId, privateDnsZoneArmResourceId: postgresDnsId, publicNetworkAccess: 'Disabled' }
  }
}
resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = [for db in databases: {
  parent: pg
  name: db
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}]
resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = { parent: pg, name: 'azure.extensions', properties: { value: 'VECTOR', source: 'user-override' } }
resource tls 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = { parent: pg, name: 'require_secure_transport', properties: { value: 'ON', source: 'user-override' } }
output environmentId string = environment.id
output defaultDomain string = environment.properties.defaultDomain
output vaultId string = vault.id
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output postgresHost string = pg.properties.fullyQualifiedDomainName
output logWorkspaceId string = logs.id
