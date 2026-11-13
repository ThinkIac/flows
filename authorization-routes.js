import { authorizations } from './lib/authorization.mjs';

export function routerAuthorizationGet(req) {
  /** @register_router workflows/:id/authorization @method GET */
  try { return { success: true, authorization: authorizations.preview(req.params.id) }; }
  catch (error) { return { success: false, error: error.message }; }
}

export function routerAuthorizationApprove(req) {
  /** @register_router workflows/:id/authorization @method POST */
  try { return { success: true, authorization: authorizations.approve(req.params.id, req.body?.scopeHash) }; }
  catch (error) { return { success: false, error: error.message }; }
}

export function routerAuthorizationRevoke(req) {
  /** @register_router workflows/:id/authorization @method DELETE */
  try { return { success: true, authorization: authorizations.revoke(req.params.id) }; }
  catch (error) { return { success: false, error: error.message }; }
}
