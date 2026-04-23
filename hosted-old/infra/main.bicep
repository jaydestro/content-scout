// Content Scout — Hosted Agent Infrastructure
// Deploys a secure, end-to-end production stack:
//   - Azure AI Foundry project (hosts the agent runtime + model deployments)
//   - Azure Container Registry (stores agent image)
//   - User-assigned Managed Identity (auth for everything; zero secrets)
//   - Azure Key Vault (scanner API keys: Reddit, YouTube, Bluesky, X)
//   - Azure Storage Account (persistent reports + dedup tracker)
//   - Log Analytics workspace (container logs + diagnostics)
//
// All role assignments follow least-privilege. No connection strings, no keys in env.

targetScope = 'resourceGroup'

@minLength(1)
@maxLength(20)
@description('Environment name; used as a prefix for all resource names.')
param environmentName string

@description('Primary deployment location.')
param location string = resourceGroup().location

@description('Model to deploy for LLM features (social posts, sentiment, trends).')
param modelName string = 'gpt-4o-mini'

@description('Model version.')
param modelVersion string = '2024-07-18'

@description('Model deployment capacity (TPM in thousands).')
param modelCapacity int = 50

@description('Tags applied to all resources.')
param tags object = {
  'azd-env-name': environmentName
  application: 'content-scout'
}

var resourceToken = uniqueString(subscription().id, resourceGroup().id, environmentName)
var abbrs = {
  acr: 'cr'
  kv: 'kv'
  sa: 'st'
  law: 'log'
  mi: 'id'
  foundry: 'aif'
}

// ---------------------------------------------------------------------------
// Managed Identity — auth for everything
// ---------------------------------------------------------------------------
resource managedIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${abbrs.mi}-${environmentName}-${resourceToken}'
  location: location
  tags: tags
}

// ---------------------------------------------------------------------------
// Log Analytics — logs + diagnostics
// ---------------------------------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${abbrs.law}-${environmentName}-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    features: { enableLogAccessUsingOnlyResourcePermissions: true }
  }
}

// ---------------------------------------------------------------------------
// Container Registry — stores agent image
// ---------------------------------------------------------------------------
resource containerRegistry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' = {
  name: '${abbrs.acr}${replace(environmentName, '-', '')}${resourceToken}'
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false // no admin user — MI only
    publicNetworkAccess: 'Enabled'
    anonymousPullEnabled: false
  }
}

// MI needs AcrPull to let Foundry runtime fetch the image
resource acrPullRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(containerRegistry.id, managedIdentity.id, 'acr-pull')
  scope: containerRegistry
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    // AcrPull
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

// ---------------------------------------------------------------------------
// Key Vault — scanner API keys
// ---------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${abbrs.kv}-${environmentName}-${resourceToken}'
  location: location
  tags: tags
  properties: {
    sku: { family: 'A', name: 'standard' }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true // use RBAC, not access policies
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: 'Enabled'
  }
}

// MI needs Key Vault Secrets User to read scanner API keys
resource kvSecretsUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, managedIdentity.id, 'kv-secrets-user')
  scope: keyVault
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    // Key Vault Secrets User
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

// ---------------------------------------------------------------------------
// Storage Account — persistent reports + dedup tracker
// ---------------------------------------------------------------------------
resource storageAccount 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: '${abbrs.sa}${replace(environmentName, '-', '')}${resourceToken}'
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false // MI only — no key-based access
    publicNetworkAccess: 'Enabled'
    defaultToOAuthAuthentication: true
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: storageAccount
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 30 }
    containerDeleteRetentionPolicy: { enabled: true, days: 30 }
  }
}

resource reportsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'reports'
  properties: { publicAccess: 'None' }
}

resource socialPostsContainer 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = {
  parent: blobService
  name: 'social-posts'
  properties: { publicAccess: 'None' }
}

// MI needs Storage Blob Data Contributor to read/write reports
resource storageBlobRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(storageAccount.id, managedIdentity.id, 'storage-blob-contributor')
  scope: storageAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    // Storage Blob Data Contributor
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', 'ba92f5b4-2d11-453d-a403-e96b0029c9fe')
  }
}

// ---------------------------------------------------------------------------
// Azure AI Foundry — hosts the agent + model deployment
// ---------------------------------------------------------------------------
resource foundryAccount 'Microsoft.CognitiveServices/accounts@2024-10-01' = {
  name: '${abbrs.foundry}-${environmentName}-${resourceToken}'
  location: location
  tags: tags
  kind: 'AIServices'
  sku: { name: 'S0' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${managedIdentity.id}': {}
    }
  }
  properties: {
    customSubDomainName: '${abbrs.foundry}-${environmentName}-${resourceToken}'
    publicNetworkAccess: 'Enabled'
    disableLocalAuth: true // MI only — no API keys
    allowProjectManagement: true
  }
}

resource foundryProject 'Microsoft.CognitiveServices/accounts/projects@2024-10-01' = {
  parent: foundryAccount
  name: 'content-scout-project'
  location: location
  tags: tags
  identity: { type: 'SystemAssigned' }
  properties: {}
}

resource modelDeployment 'Microsoft.CognitiveServices/accounts/deployments@2024-10-01' = {
  parent: foundryAccount
  name: modelName
  sku: {
    name: 'GlobalStandard'
    capacity: modelCapacity
  }
  properties: {
    model: {
      format: 'OpenAI'
      name: modelName
      version: modelVersion
    }
    raiPolicyName: 'Microsoft.DefaultV2'
  }
}

// MI needs Azure AI User role on the Foundry account to invoke models
resource foundryUserRoleAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(foundryAccount.id, managedIdentity.id, 'azure-ai-user')
  scope: foundryAccount
  properties: {
    principalId: managedIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    // Azure AI User (formerly Cognitive Services User + OpenAI User)
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
  }
}

// Diagnostic settings — ship logs to Log Analytics
resource foundryDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'send-to-law'
  scope: foundryAccount
  properties: {
    workspaceId: logAnalytics.id
    logs: [
      { categoryGroup: 'allLogs', enabled: true }
      { categoryGroup: 'audit', enabled: true }
    ]
    metrics: [
      { category: 'AllMetrics', enabled: true }
    ]
  }
}

// ---------------------------------------------------------------------------
// Outputs — consumed by azd + agent.yaml
// ---------------------------------------------------------------------------
output AZURE_LOCATION string = location
output AZURE_TENANT_ID string = subscription().tenantId
output AZURE_SUBSCRIPTION_ID string = subscription().subscriptionId
output AZURE_RESOURCE_GROUP string = resourceGroup().name

output AZURE_CLIENT_ID string = managedIdentity.properties.clientId
output AZURE_MANAGED_IDENTITY_ID string = managedIdentity.id
output AZURE_MANAGED_IDENTITY_PRINCIPAL_ID string = managedIdentity.properties.principalId

output AZURE_CONTAINER_REGISTRY_ENDPOINT string = containerRegistry.properties.loginServer
output AZURE_CONTAINER_REGISTRY_NAME string = containerRegistry.name

output AZURE_KEY_VAULT_ENDPOINT string = keyVault.properties.vaultUri
output AZURE_KEY_VAULT_NAME string = keyVault.name

output AZURE_STORAGE_ACCOUNT_NAME string = storageAccount.name
output AZURE_STORAGE_BLOB_ENDPOINT string = storageAccount.properties.primaryEndpoints.blob

output AZURE_AI_PROJECT_ENDPOINT string = foundryProject.properties.endpoints['AI Foundry API']
output AZURE_AI_FOUNDRY_ENDPOINT string = foundryAccount.properties.endpoint
output AZURE_AI_FOUNDRY_NAME string = foundryAccount.name
output AZURE_AI_PROJECT_NAME string = foundryProject.name
output MODEL_DEPLOYMENT_NAME string = modelDeployment.name

output AZURE_LOG_ANALYTICS_WORKSPACE_ID string = logAnalytics.id
