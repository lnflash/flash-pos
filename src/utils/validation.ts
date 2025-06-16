/**
 * Validation utilities for secure input handling
 */

/**
 * Validates a Merchant Reward ID to prevent injection attacks
 * Only allows alphanumeric characters, hyphens, and underscores
 * Maximum length of 100 characters
 */
export const validateMerchantRewardId = (id: string): boolean => {
  if (!id || typeof id !== 'string') {
    return false;
  }
  
  const sanitized = id.trim();
  
  // Check length
  if (sanitized.length === 0 || sanitized.length > 100) {
    return false;
  }
  
  // Only allow safe characters: alphanumeric, hyphens, underscores
  // This prevents URL injection and path traversal attacks
  const safePattern = /^[a-zA-Z0-9-_]+$/;
  
  return safePattern.test(sanitized);
};

/**
 * Sanitizes a Merchant Reward ID for safe use in URLs
 * Returns the sanitized ID or null if invalid
 */
export const sanitizeMerchantRewardId = (id: string): string | null => {
  if (!validateMerchantRewardId(id)) {
    return null;
  }
  
  return id.trim();
};

/**
 * Validates numeric input for reward settings
 */
export const validateNumericInput = (
  value: string,
  min: number,
  max: number,
): boolean => {
  const num = parseFloat(value);
  return !isNaN(num) && num >= min && num <= max;
};

/**
 * Debug logging that only runs in development
 */
export const debugLog = (...args: any[]): void => {
  if (__DEV__) {
    console.log(...args);
  }
};