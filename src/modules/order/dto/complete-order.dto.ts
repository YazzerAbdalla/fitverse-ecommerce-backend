/**
 * This DTO represents the complete-order request.
 * It is intentionally empty — completion is cart-derived and order-scoped.
 * Any extra field is rejected by the global ValidationPipe (forbidNonWhitelisted).
 */
export class CompleteOrderDto {}
