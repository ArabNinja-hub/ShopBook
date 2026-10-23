import { ApiError, BadRequestError } from '../errors';

export { BadRequestError };

export class NotFoundApiError extends ApiError {
  constructor(message: string) {
    super(404, 'NOT_FOUND', message);
    this.name = 'NotFoundApiError';
  }
}
