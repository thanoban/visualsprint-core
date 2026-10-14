param name string
param location string
param egressIp string
param endpointsSubnetId string
param blobDnsId string
param pubsubDnsId string

resource bus 'Microsoft.ServiceBus/namespaces@2024-01-01' = {
  name: '${name}-bus'
  location: location
  sku: { name: 'Standard', tier: 'Standard' }
  properties: { disableLocalAuth: true, minimumTlsVersion: '1.2', publicNetworkAccess: 'Enabled' }
}
resource firewall 'Microsoft.ServiceBus/namespaces/networkRuleSets@2024-01-01' = {
  parent: bus
  name: 'default'
  properties: { publicNetworkAccess: 'Enabled', defaultAction: 'Deny', trustedServiceAccessEnabled: false, virtualNetworkRules: [], ipRules: [{ ipMask: egressIp, action: 'Allow' }] }
}
var publishers = ['workspace', 'ingest', 'workflow', 'notification', 'intelligence']
resource topics 'Microsoft.ServiceBus/namespaces/topics@2024-01-01' = [for service in publishers: {
  parent: bus
  name: 'vs-${service}'
  properties: { enablePartitioning: false, requiresDuplicateDetection: true, duplicateDetectionHistoryTimeWindow: 'PT10M', defaultMessageTimeToLive: 'P7D', maxSizeInMegabytes: 1024 }
}]
resource subscriptions 'Microsoft.ServiceBus/namespaces/topics/subscriptions@2024-01-01' = [for i in [1, 2, 4]: {
  parent: topics[i]
  name: 'notification'
  properties: { maxDeliveryCount: 10, lockDuration: 'PT1M', deadLetteringOnMessageExpiration: true, requiresSession: false }
}]
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: replace('${name}text', '-', '')
  location: location
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: { allowBlobPublicAccess: false, allowSharedKeyAccess: false, publicNetworkAccess: 'Disabled', minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true, networkAcls: { bypass: 'None', defaultAction: 'Deny' } }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storage
  name: 'default'
  // Immediate deletion is deliberate: do not retain additional copies of text through blob versioning.
  properties: { isVersioningEnabled: false, deleteRetentionPolicy: { enabled: false }, containerDeleteRetentionPolicy: { enabled: false } }
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for container in ['text-imports', 'text-exports']: { parent: blobs, name: container, properties: { publicAccess: 'None' } }]
module storageEndpoint './private-endpoint.bicep' = {
  name: 'text-private-endpoint'
  params: { name: '${name}-blob-pe', location: location, subnetId: endpointsSubnetId, targetId: storage.id, groupId: 'blob', dnsZoneId: blobDnsId }
}
resource pubsub 'Microsoft.SignalRService/webPubSub@2024-03-01' = {
  name: '${name}-pubsub'
  location: location
  sku: { name: 'Standard_S1', tier: 'Standard', capacity: 1 }
  properties: {
    disableLocalAuth: true
    disableAadAuth: false
    publicNetworkAccess: 'Enabled'
    tls: { clientCertEnabled: false }
    networkACLs: { defaultAction: 'Allow', publicNetwork: { allow: ['ClientConnection'], deny: ['RESTAPI', 'ServerConnection', 'Trace'] } }
    liveTraceConfiguration: { enabled: 'false' }
  }
}
module pubsubEndpoint './private-endpoint.bicep' = {
  name: 'pubsub-private-endpoint'
  params: { name: '${name}-pubsub-pe', location: location, subnetId: endpointsSubnetId, targetId: pubsub.id, groupId: 'webpubsub', dnsZoneId: pubsubDnsId }
}
output namespaceId string = bus.id
output namespaceHost string = '${bus.name}.servicebus.windows.net'
output textStorageId string = storage.id
output textStorageHost string = storage.properties.primaryEndpoints.blob
output pubsubId string = pubsub.id
output pubsubHost string = pubsub.properties.hostName
