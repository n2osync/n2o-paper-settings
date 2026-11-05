/**
 * The action table. Commands, the status-bar menu and the picture menus are
 * all built from these lists, so the surfaces cannot drift apart.
 */
import type { Control } from './parse';
import type N2OPaperSettingsPlugin from './main';
import { LookPicker } from './looks-modal';

export interface Action {
  id: string;
  name: string;
  icon: string;
  /** Also a row in the status-bar menu. */
  inMenu: boolean;
  available: () => boolean;
  checked?: () => boolean;
  /** The status-bar menu's label, when it differs from the command name. */
  label?: () => string;
  run: () => unknown;
}

export function lookActions(p: N2OPaperSettingsPlugin): Action[] {
  const control = (id: string): Control | undefined => p.spec.controls.find((c) => c.id === id && (
    c.type === 'class-toggle'
    || ((c.type === 'class-select' || c.type === 'variable-select') && c.options.length > 1)
    || (c.type === 'variable-number' && !!c.cycle?.length)));
  const stepper = (id: string, command: string, name: string, icon: string, inMenu: boolean): Action => ({
    id: command, name, icon, inMenu,
    available: () => !!control(id),
    label: () => control(id)?.title ?? name,
    checked: () => {
      const c = control(id);
      return !!c && c.type === 'class-toggle' && p.valueOf(c) === true;
    },
    run: () => {
      const c = control(id);
      if (c) void p.step(c);
    },
  });
  const slot = (n: number): Action => ({
    id: `apply-look-${n}`,
    name: `Apply look ${n}`,
    icon: 'palette',
    inMenu: false,
    available: () => p.looks().length >= n,
    run: () => {
      const look = p.looks()[n - 1];
      if (look) void p.applyLook(look);
    },
  });
  return [
    {
      id: 'choose-look', name: 'Choose a look...', icon: 'palette', inMenu: false,
      available: () => p.looks().length > 0,
      run: () => new LookPicker(p).open(),
    },
    slot(1), slot(2), slot(3),
    stepper('n2o-palette', 'cycle-palette', 'Cycle palette', 'swatch-book', false),
    stepper('n2o-flat-paper', 'toggle-flat-paper', 'Toggle flat paper', 'square', true),
    stepper('n2o-coil-binding', 'toggle-coil-binding', 'Toggle coil binding', 'notebook', true),
    stepper('width-body-content', 'cycle-column-width', 'Cycle column width', 'move-horizontal', false),
    stepper('n2o-plain-callouts', 'toggle-callout-style', 'Toggle callout style', 'sticky-note', true),
  ];
}

/** The theme's picture flags, offered in the picture menu and the editor menu. */
export const PICTURE_FLAGS: { flag: string; label: string }[] = [
  { flag: 'plain', label: 'No print mount' },
  { flag: 'aged', label: 'Aged print' },
  { flag: 'round', label: 'Round' },
  { flag: 'left', label: 'Float left' },
  { flag: 'right', label: 'Float right' },
];
