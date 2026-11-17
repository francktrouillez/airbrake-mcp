/**
 * Write actions that moved out of the read-only resource tools (see the
 * CHANGELOG "BREAKING" entry). A caller still using one (e.g. from a cached
 * tool list) gets a pointer to the replacement instead of a bare
 * "Invalid discriminator value".
 */
export function assertNotMovedAction(
  tool: string,
  input: unknown,
  moved: Readonly<Record<string, string>>,
  readOnly: boolean,
): void {
  const action = (input as { action?: unknown } | null | undefined)?.action;
  if (typeof action !== 'string' || !Object.hasOwn(moved, action)) return;
  // In read-only mode the replacement is hidden too — say so rather than
  // send the caller to a tool that will refuse.
  const hint = readOnly
    ? `it moved to ${moved[action]}, which is disabled: AIRBRAKE_READ_ONLY is set`
    : `use ${moved[action]}`;
  throw new Error(`${tool} no longer supports action "${action}": ${hint}`);
}
