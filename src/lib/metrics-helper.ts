import {
  dbQueryDuration,
  dbQueryTotal,
  authAttempts,
  authDuration,
  externalApiCallDuration,
  externalApiCallTotal,
  llmCallDuration,
  llmCallTotal,
  llmTokensUsed,
  fileUploadDuration,
  fileUploadSize,
  fileUploadTotal,
  blockchainTxDuration,
  blockchainTxTotal,
  errorTotal,
  userOperations,
  smartProfileOperations,
  crmOperations,
} from './metrics';

/**
 * Helper function to measure database query execution time
 */
export async function measureDbQuery<T>(operation: string, entity: string, queryFn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let status = 'success';

  try {
    const result = await queryFn();
    return result;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - start) / 1000;
    dbQueryDuration.observe({ operation, entity, status }, duration);
    dbQueryTotal.inc({ operation, entity, status });
  }
}

/**
 * Helper function to measure authentication operations
 */
export async function measureAuth<T>(method: string, authFn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let status = 'success';

  try {
    const result = await authFn();
    return result;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - start) / 1000;
    authAttempts.inc({ method, status });
    authDuration.observe({ method, status }, duration);
  }
}

/**
 * Helper function to measure external API calls
 */
export async function measureExternalApiCall<T>(
  service: string,
  operation: string,
  callFn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let status = 'success';

  try {
    const result = await callFn();
    return result;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - start) / 1000;
    externalApiCallDuration.observe({ service, operation, status }, duration);
    externalApiCallTotal.inc({ service, operation, status });
  }
}

/**
 * Helper function to measure LLM API calls
 */
export async function measureLlmCall<T>(
  provider: string,
  model: string,
  operation: string,
  callFn: () => Promise<T>,
  tokensUsed?: { prompt?: number; completion?: number; total?: number },
): Promise<T> {
  const start = Date.now();
  let status = 'success';

  try {
    const result = await callFn();
    return result;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - start) / 1000;
    llmCallDuration.observe({ provider, model, operation, status }, duration);
    llmCallTotal.inc({ provider, model, operation, status });

    // Track token usage if provided
    if (tokensUsed) {
      if (tokensUsed.prompt) {
        llmTokensUsed.inc({ provider, model, type: 'prompt' }, tokensUsed.prompt);
      }
      if (tokensUsed.completion) {
        llmTokensUsed.inc({ provider, model, type: 'completion' }, tokensUsed.completion);
      }
      if (tokensUsed.total) {
        llmTokensUsed.inc({ provider, model, type: 'total' }, tokensUsed.total);
      }
    }
  }
}

/**
 * Helper function to measure file upload operations
 */
export async function measureFileUpload<T>(
  destination: string,
  fileType: string,
  fileSize: number,
  uploadFn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  let status = 'success';

  try {
    const result = await uploadFn();

    fileUploadSize.observe({ destination, file_type: fileType }, fileSize);
    return result;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - start) / 1000;
    fileUploadDuration.observe({ destination, status }, duration);

    fileUploadTotal.inc({ destination, file_type: fileType, status });
  }
}

/**
 * Helper function to measure blockchain transactions
 */
export async function measureBlockchainTx<T>(network: string, operation: string, txFn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  let status = 'success';

  try {
    const result = await txFn();
    return result;
  } catch (error) {
    status = 'error';
    throw error;
  } finally {
    const duration = (Date.now() - start) / 1000;
    blockchainTxDuration.observe({ network, operation, status }, duration);
    blockchainTxTotal.inc({ network, operation, status });
  }
}

/**
 * Helper function to track errors
 */
export function trackError(service: string, errorType: string, severity: 'low' | 'medium' | 'high' | 'critical') {
  errorTotal.inc({ service, error_type: errorType, severity });
}

/**
 * Helper function to track user operations
 */
export function trackUserOperation(operation: string, status: 'success' | 'error') {
  userOperations.inc({ operation, status });
}

/**
 * Helper function to track smart profile operations
 */
export function trackSmartProfileOperation(operation: string, status: 'success' | 'error') {
  smartProfileOperations.inc({ operation, status });
}

/**
 * Helper function to track CRM operations
 */
export function trackCrmOperation(operation: string, entity: string, status: 'success' | 'error') {
  crmOperations.inc({ operation, entity, status });
}
