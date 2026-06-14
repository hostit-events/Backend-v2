import { SetMetadata } from '@nestjs/common';

export const SKIP_TRANSFORM = 'skipTransform';

/**
 * Marks a route handler whose response should NOT be wrapped in the
 * standard `{ success, data, timestamp }` envelope by TransformInterceptor.
 * Use for raw payloads like file/CSV downloads.
 */
export const SkipTransform = () => SetMetadata(SKIP_TRANSFORM, true);
