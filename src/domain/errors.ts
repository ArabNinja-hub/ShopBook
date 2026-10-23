/**
 * Custom error classes used by ShopBook's business logic.
 * Keeping error types explicit makes it easy to show clear, helpful messages
 * to the shop owner instead of cryptic browser errors.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class InsufficientStockError extends Error {
  public readonly productId: string;
  public readonly productName: string;
  public readonly availableQty: number;
  public readonly requestedQty: number;

  constructor(
    productId: string,
    productName: string,
    availableQty: number,
    requestedQty: number
  ) {
    super(
      `Not enough stock for "${productName}". Only ${availableQty} in stock, tried to sell ${requestedQty}.`
    );
    this.name = 'InsufficientStockError';
    this.productId = productId;
    this.productName = productName;
    this.availableQty = availableQty;
    this.requestedQty = requestedQty;
  }
}

export class DuplicateOperationError extends Error {
  public readonly operationId: string;

  constructor(operationId: string, message = 'This transaction has already been recorded.') {
    super(message);
    this.name = 'DuplicateOperationError';
    this.operationId = operationId;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}
