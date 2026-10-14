param name string
param location string

resource ip 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: '${name}-egress'
  location: location
  sku: { name: 'Standard' }
  properties: { publicIPAllocationMethod: 'Static' }
}
resource nat 'Microsoft.Network/natGateways@2024-05-01' = {
  name: '${name}-nat'
  location: location
  sku: { name: 'Standard' }
  properties: { publicIpAddresses: [{ id: ip.id }] }
}
resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: name
  location: location
  properties: {
    addressSpace: { addressPrefixes: ['10.42.0.0/16'] }
    subnets: [
      { name: 'account-apps', properties: { addressPrefix: '10.42.0.0/23', natGateway: { id: nat.id }, delegations: [{ name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } }] } }
      { name: 'cell-apps', properties: { addressPrefix: '10.42.2.0/23', natGateway: { id: nat.id }, delegations: [{ name: 'apps', properties: { serviceName: 'Microsoft.App/environments' } }] } }
      { name: 'account-pg', properties: { addressPrefix: '10.42.4.0/24', delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }] } }
      { name: 'cell-pg', properties: { addressPrefix: '10.42.5.0/24', delegations: [{ name: 'postgres', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }] } }
      { name: 'endpoints', properties: { addressPrefix: '10.42.6.0/24', privateEndpointNetworkPolicies: 'Disabled' } }
    ]
  }
}
resource postgresDns 'Microsoft.Network/privateDnsZones@2024-06-01' = { name: '${name}.postgres.database.azure.com', location: 'global' }
resource postgresLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: postgresDns
  name: 'regional-network'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}
output vnetId string = vnet.id
output accountAppsSubnetId string = '${vnet.id}/subnets/account-apps'
output cellAppsSubnetId string = '${vnet.id}/subnets/cell-apps'
output accountPgSubnetId string = '${vnet.id}/subnets/account-pg'
output cellPgSubnetId string = '${vnet.id}/subnets/cell-pg'
output endpointsSubnetId string = '${vnet.id}/subnets/endpoints'
output postgresDnsId string = postgresDns.id
output egressIp string = ip.properties.ipAddress
var privateZones = ['privatelink.vaultcore.azure.net', 'privatelink.blob.${environment().suffixes.storage}', 'privatelink.webpubsub.azure.com']
resource privateDns 'Microsoft.Network/privateDnsZones@2024-06-01' = [for zone in privateZones: { name: zone, location: 'global' }]
resource privateLinks 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [for (zone, i) in privateZones: {
  parent: privateDns[i]
  name: 'regional-network'
  location: 'global'
  properties: { registrationEnabled: false, virtualNetwork: { id: vnet.id } }
}]
output vaultDnsId string = privateDns[0].id
output blobDnsId string = privateDns[1].id
output pubsubDnsId string = privateDns[2].id
