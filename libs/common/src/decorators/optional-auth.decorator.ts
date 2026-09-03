import { SetMetadata } from '@nestjs/common';

export const IS_OPTIONAL_AUTH_KEY = 'isOptionalAuth';

/**
 * Between `@Public()` and fully guarded.
 *
 * The route works without a token, but if one is supplied it is verified and
 * the caller's identity is attached. Guest carts need exactly this: an
 * anonymous shopper must be able to build a cart, while a signed-in one has to
 * be identified so their cart is actually theirs.
 *
 * A token that is present but invalid is still rejected. Treating it as
 * anonymous would silently hand a logged-in shopper someone else's empty cart
 * the moment their session expired.
 */
export const OptionalAuth = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_OPTIONAL_AUTH_KEY, true);
