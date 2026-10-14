param name string
param location string
param subnetId string
param targetId string
param groupId string
param dnsZoneId string
resource endpoint 'Microsoft.Network/privateEndpoints@2024-05-01' = {
  name: name
  location: location
  properties: {
    subnet: { id: subnetId }
    privateLinkServiceConnections: [{ name: name, properties: { privateLinkServiceId: targetId, groupIds: [groupId] } }]
  }
}
resource group 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2024-05-01' = {
  parent: endpoint
  name: 'default'
  properties: { privateDnsZoneConfigs: [{ name: 'default', properties: { privateDnsZoneId: dnsZoneId } }] }
}
