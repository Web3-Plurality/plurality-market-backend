import { Registry, Counter, Histogram, Gauge, collectDefaultMetrics } from 'prom-client';

// Create a custom registry
export const register = new Registry();

// Collect default metrics (CPU, memory, event loop lag, etc.)
collectDefaultMetrics({
  register,
  prefix: 'plurality_backend_',
  gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
});

// ===== HTTP Metrics =====

export const httpRequestDuration = new Histogram({
  name: 'plurality_backend_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [register],
});

export const httpRequestTotal = new Counter({
  name: 'plurality_backend_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'service'],
  registers: [register],
});

export const httpRequestSize = new Histogram({
  name: 'plurality_backend_http_request_size_bytes',
  help: 'Size of HTTP requests in bytes',
  labelNames: ['method', 'route', 'service'],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  registers: [register],
});

export const httpResponseSize = new Histogram({
  name: 'plurality_backend_http_response_size_bytes',
  help: 'Size of HTTP responses in bytes',
  labelNames: ['method', 'route', 'service'],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
  registers: [register],
});

export const httpActiveRequests = new Gauge({
  name: 'plurality_backend_http_active_requests',
  help: 'Number of active HTTP requests',
  labelNames: ['method', 'service'],
  registers: [register],
});

// ===== Database Metrics =====

export const dbQueryDuration = new Histogram({
  name: 'plurality_backend_db_query_duration_seconds',
  help: 'Duration of database queries in seconds',
  labelNames: ['operation', 'entity', 'status'],
  buckets: [0.001, 0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const dbQueryTotal = new Counter({
  name: 'plurality_backend_db_queries_total',
  help: 'Total number of database queries',
  labelNames: ['operation', 'entity', 'status'],
  registers: [register],
});

export const dbConnectionPoolSize = new Gauge({
  name: 'plurality_backend_db_connection_pool_size',
  help: 'Current database connection pool size',
  registers: [register],
});

export const dbConnectionPoolActive = new Gauge({
  name: 'plurality_backend_db_connection_pool_active',
  help: 'Number of active database connections',
  registers: [register],
});

export const dbConnectionPoolIdle = new Gauge({
  name: 'plurality_backend_db_connection_pool_idle',
  help: 'Number of idle database connections',
  registers: [register],
});

// ===== Authentication Metrics =====

export const authAttempts = new Counter({
  name: 'plurality_backend_auth_attempts_total',
  help: 'Total number of authentication attempts',
  labelNames: ['method', 'status'],
  registers: [register],
});

export const authDuration = new Histogram({
  name: 'plurality_backend_auth_duration_seconds',
  help: 'Duration of authentication operations',
  labelNames: ['method', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
  registers: [register],
});

export const activeSessions = new Gauge({
  name: 'plurality_backend_active_sessions',
  help: 'Number of active user sessions',
  registers: [register],
});

// ===== OAuth Provider Metrics =====

export const oauthCallDuration = new Histogram({
  name: 'plurality_backend_oauth_call_duration_seconds',
  help: 'Duration of OAuth provider API calls',
  labelNames: ['provider', 'operation', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const oauthCallTotal = new Counter({
  name: 'plurality_backend_oauth_calls_total',
  help: 'Total number of OAuth provider API calls',
  labelNames: ['provider', 'operation', 'status'],
  registers: [register],
});

export const oauthErrors = new Counter({
  name: 'plurality_backend_oauth_errors_total',
  help: 'Total number of OAuth errors',
  labelNames: ['provider', 'error_type'],
  registers: [register],
});

// ===== External API Metrics =====

export const externalApiCallDuration = new Histogram({
  name: 'plurality_backend_external_api_duration_seconds',
  help: 'Duration of external API calls',
  labelNames: ['service', 'operation', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const externalApiCallTotal = new Counter({
  name: 'plurality_backend_external_api_calls_total',
  help: 'Total number of external API calls',
  labelNames: ['service', 'operation', 'status'],
  registers: [register],
});

// ===== LLM/AI Metrics =====

export const llmCallDuration = new Histogram({
  name: 'plurality_backend_llm_call_duration_seconds',
  help: 'Duration of LLM API calls',
  labelNames: ['provider', 'model', 'operation', 'status'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

export const llmCallTotal = new Counter({
  name: 'plurality_backend_llm_calls_total',
  help: 'Total number of LLM API calls',
  labelNames: ['provider', 'model', 'operation', 'status'],
  registers: [register],
});

export const llmTokensUsed = new Counter({
  name: 'plurality_backend_llm_tokens_total',
  help: 'Total number of LLM tokens used',
  labelNames: ['provider', 'model', 'type'],
  registers: [register],
});

// ===== File Upload Metrics =====

export const fileUploadDuration = new Histogram({
  name: 'plurality_backend_file_upload_duration_seconds',
  help: 'Duration of file upload operations',
  labelNames: ['destination', 'status'],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [register],
});

export const fileUploadSize = new Histogram({
  name: 'plurality_backend_file_upload_size_bytes',
  help: 'Size of uploaded files',
  labelNames: ['destination', 'file_type'],
  buckets: [1024, 10240, 102400, 1024000, 10240000, 102400000],
  registers: [register],
});

export const fileUploadTotal = new Counter({
  name: 'plurality_backend_file_uploads_total',
  help: 'Total number of file uploads',
  labelNames: ['destination', 'file_type', 'status'],
  registers: [register],
});

// ===== Blockchain Metrics =====

export const blockchainTxDuration = new Histogram({
  name: 'plurality_backend_blockchain_tx_duration_seconds',
  help: 'Duration of blockchain transactions',
  labelNames: ['network', 'operation', 'status'],
  buckets: [1, 5, 10, 30, 60, 120, 300],
  registers: [register],
});

export const blockchainTxTotal = new Counter({
  name: 'plurality_backend_blockchain_tx_total',
  help: 'Total number of blockchain transactions',
  labelNames: ['network', 'operation', 'status'],
  registers: [register],
});

// ===== SSE Metrics =====

export const sseActiveConnections = new Gauge({
  name: 'plurality_backend_sse_active_connections',
  help: 'Number of active SSE connections',
  labelNames: ['event_type'],
  registers: [register],
});

export const sseMessagesSent = new Counter({
  name: 'plurality_backend_sse_messages_sent_total',
  help: 'Total number of SSE messages sent',
  labelNames: ['event_type'],
  registers: [register],
});

// ===== Business Metrics =====

export const userOperations = new Counter({
  name: 'plurality_backend_user_operations_total',
  help: 'Total number of user operations',
  labelNames: ['operation', 'status'],
  registers: [register],
});

export const smartProfileOperations = new Counter({
  name: 'plurality_backend_smart_profile_operations_total',
  help: 'Total number of smart profile operations',
  labelNames: ['operation', 'status'],
  registers: [register],
});

export const crmOperations = new Counter({
  name: 'plurality_backend_crm_operations_total',
  help: 'Total number of CRM operations',
  labelNames: ['operation', 'entity', 'status'],
  registers: [register],
});

export const ipCreditOperations = new Counter({
  name: 'plurality_backend_ip_credit_operations_total',
  help: 'Total number of IP credit operations',
  labelNames: ['operation', 'status'],
  registers: [register],
});

// ===== Error Metrics =====

export const errorTotal = new Counter({
  name: 'plurality_backend_errors_total',
  help: 'Total number of errors',
  labelNames: ['service', 'error_type', 'severity'],
  registers: [register],
});

export const unhandledErrors = new Counter({
  name: 'plurality_backend_unhandled_errors_total',
  help: 'Total number of unhandled errors',
  labelNames: ['type'],
  registers: [register],
});

// ===== Health Metrics =====

export const healthStatus = new Gauge({
  name: 'plurality_backend_health_status',
  help: 'Health status of the service (1 = healthy, 0 = unhealthy)',
  labelNames: ['component'],
  registers: [register],
});

// ===== Per-User Request Metrics =====

export const userRagRequests = new Counter({
  name: 'plurality_backend_user_rag_requests_total',
  help: 'Total RAG requests per user',
  labelNames: ['user_id', 'endpoint_type'],
  registers: [register],
});

export const userQueryRequests = new Counter({
  name: 'plurality_backend_user_query_requests_total',
  help: 'Total query requests per user',
  labelNames: ['user_id', 'endpoint_type'],
  registers: [register],
});

export const userProfileOperations = new Counter({
  name: 'plurality_backend_user_profile_operations_total',
  help: 'Total profile operations per user',
  labelNames: ['user_id', 'operation'],
  registers: [register],
});
