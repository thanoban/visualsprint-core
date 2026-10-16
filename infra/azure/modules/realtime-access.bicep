param resourceName string
param principalId string
resource pubsub 'Microsoft.SignalRService/webPubSub@2024-03-01' existing = { name: resourceName }
// Built-in data-plane role, scoped only to this cell's Web PubSub resource.
// This is not Azure Contributor/Owner or a resource-group-wide grant.
resource role 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(pubsub.id, principalId, 'notification-realtime')
  scope: pubsub
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '12cf5a90-567b-43ae-8102-96cf46c7d9b4')
  }
}
