/**
 * The signed-in person and sign-out, as a menu button. Radix DropdownMenu supplies the WAI-ARIA
 * menu-button behaviour (keyboard, focus return, dismissal); it ships no styles, and the look comes
 * from the Timeline tokens in shell.css (DL-0070, DL-0109) — never the default shadcn theme.
 */
import * as Menu from '@radix-ui/react-dropdown-menu';

export function UserMenu({
  name,
  busy,
  onSignOut,
}: {
  name: string;
  busy: boolean;
  onSignOut: () => void;
}) {
  return (
    // Not modal: a modal menu hides the rest of the page with aria-hidden while its links stay
    // focusable (axe aria-hidden-focus). The APG menu button needs no modality; Escape, Tab and
    // outside clicks still close it.
    <Menu.Root modal={false}>
      <Menu.Trigger className="me">
        {name}
        <span className="sr-only">, account menu</span>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="menu" align="end" sideOffset={6} collisionPadding={16}>
          <Menu.Label className="menu-label">Signed in as {name}</Menu.Label>
          <Menu.Separator className="menu-sep" />
          <Menu.Item className="menu-item" disabled={busy} onSelect={onSignOut}>
            Sign out
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
