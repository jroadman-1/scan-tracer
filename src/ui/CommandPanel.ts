/**
 * Fusion-style command dialog: a title, guidance, optional controls, and
 * OK / Cancel. One command shows at a time.
 */
export interface PanelButton {
  label: string;
  title?: string;
  on?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

export interface PanelContent {
  title: string;
  /** Steps shown as a checklist; the first unchecked one is current. */
  steps?: { label: string; done: boolean }[];
  note?: string;
  /** Rows of buttons; a row of 2+ renders as a segmented control. */
  rows?: PanelButton[][];
  okEnabled: boolean;
  okLabel?: string;
  cancelLabel?: string;
  /** Only the OK button (for tools whose work is saved as you go). */
  hideCancel?: boolean;
  onOk: () => void;
  onCancel: () => void;
}

export class CommandPanel {
  constructor(private readonly el: HTMLElement) {}

  show(c: PanelContent) {
    const el = this.el;
    el.replaceChildren();
    el.hidden = false;

    const title = document.createElement('div');
    title.className = 'cmd-title';
    title.textContent = c.title;
    el.appendChild(title);

    if (c.steps) {
      const list = document.createElement('ol');
      list.className = 'cmd-steps';
      const current = c.steps.findIndex((s) => !s.done);
      c.steps.forEach((s, i) => {
        const li = document.createElement('li');
        li.textContent = s.label;
        li.classList.toggle('done', s.done);
        li.classList.toggle('current', i === current);
        list.appendChild(li);
      });
      el.appendChild(list);
    }

    if (c.note) {
      const note = document.createElement('p');
      note.className = 'cmd-note';
      note.textContent = c.note;
      el.appendChild(note);
    }

    for (const row of c.rows ?? []) {
      const r = document.createElement('div');
      r.className = row.length > 1 ? 'seg cmd-row' : 'cmd-row';
      for (const b of row) r.appendChild(this.button(b, row.length > 1 ? '' : 'btn-secondary'));
      el.appendChild(r);
    }

    const actions = document.createElement('div');
    actions.className = 'cmd-actions';
    if (!c.hideCancel) {
      actions.append(this.button({ label: c.cancelLabel ?? 'Cancel', title: 'Esc', onClick: c.onCancel }, 'btn-secondary'));
    }
    actions.append(this.button({ label: c.okLabel ?? 'OK', title: 'Enter', disabled: !c.okEnabled, onClick: c.onOk }, 'btn-primary'));
    el.appendChild(actions);
  }

  hide() {
    this.el.hidden = true;
    this.el.replaceChildren();
  }

  private button(b: PanelButton, cls: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = b.label;
    if (cls) btn.className = cls;
    if (b.title) btn.title = b.title;
    btn.disabled = !!b.disabled;
    btn.classList.toggle('on', !!b.on);
    btn.addEventListener('click', b.onClick);
    return btn;
  }
}
