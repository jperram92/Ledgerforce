import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'lf:isPublic';

/** Marks a route that needs no tenant (health, OIDC callbacks). Everything else is tenant-scoped. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
