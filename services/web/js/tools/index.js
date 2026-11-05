// Tool registry: activation, toolbar state, pointer/keyboard dispatch.
import { state } from '../state.js';
import { SelectTool } from './select.js';
import { EditTextTool } from './edittext.js';
import { TextTool, ImageTool, DrawTool, ShapeTool, NoteTool } from './create.js';
import { MarkupTool } from './markup.js';
import { SignatureTool, createSignature, fitInto } from './signature.js';
import { RedactTool } from './redact.js';
import { FormTool } from './form.js';
import { closeTextEditor, hitTest } from './common.js';

// One-shot creation tools: after creating, switch to Select with the new object
// selected; pressing on an existing object selects it instead of creating another.
const ONE_SHOT = new Set(['text', 'rect', 'ellipse', 'line', 'arrow', 'note', 'image', 'signature']);
// Image and signature placement may legitimately land on top of other objects.
const PLACEMENT = new Set(['image', 'signature']);
// Tools whose own content is made of text the user typed (FreeText annotations).
const TEXT_TOOLS = new Set(['text', 'edittext']);

export const TOOL_KEYS = {
  v: 'select', e: 'edittext', t: 'text', i: 'image', d: 'draw', r: 'rect', o: 'ellipse', l: 'line',
  a: 'arrow', h: 'highlight', u: 'underline', k: 'strike', n: 'note', s: 'signature', f: 'form', x: 'redact',
};

export class ToolManager {
  constructor(app) {
    this.app = app;
    this.tools = {
      select: new SelectTool(app),
      edittext: new EditTextTool(app),
      text: new TextTool(app),
      image: new ImageTool(app),
      draw: new DrawTool(app),
      rect: new ShapeTool(app, 'rect'),
      ellipse: new ShapeTool(app, 'ellipse'),
      line: new ShapeTool(app, 'line'),
      arrow: new ShapeTool(app, 'arrow'),
      highlight: new MarkupTool(app, 'highlight'),
      underline: new MarkupTool(app, 'underline'),
      strike: new MarkupTool(app, 'strike'),
      note: new NoteTool(app),
      signature: new SignatureTool(app),
      form: new FormTool(app),
      redact: new RedactTool(app),
    };
    this.current = this.tools.select;
    this.buttons = [...document.querySelectorAll('#toolbar [data-tool]')];
    for (const b of this.buttons) b.addEventListener('click', () => this.set(b.dataset.tool));
    document.body.dataset.tool = 'select';
  }

  set(name) {
    if (!this.tools[name]) return;
    closeTextEditor(true);
    if (this.current?.name === name) {
      // re-clicking image/signature tools re-opens their chooser
      if (name === 'image') this.current.choose();
      if (name === 'signature') this.current.newSignature();
      return;
    }
    this.current?.deactivate?.();
    state.tool = name;
    this.current = this.tools[name];
    document.body.dataset.tool = name;
    for (const b of this.buttons) b.setAttribute('aria-pressed', b.dataset.tool === name);
    this.app.props.render();
    this.app.updateRedactBar();
    if (state.info) this.current.activate?.();
  }

  selectsAfterCreate(name) { return ONE_SHOT.has(name); }

  /**
   * Pressing on an existing annotation with a creation or text tool works on that
   * annotation: added text opens for editing, anything else is selected (and can
   * be dragged right away). Returns true if handled.
   */
  async interceptExisting(view, pt, e) {
    const name = state.tool;
    if ((!ONE_SHOT.has(name) && !TEXT_TOOLS.has(name)) || PLACEMENT.has(name)) return false;
    if (e.button !== 0 || !view.annots) return false;  // only with a warm cache: never delay creation
    const hit = hitTest(view.annots, pt, 2);
    if (!hit) return false;
    if (name === 'edittext' && hit.type !== 'FreeText') return false;  // edit-text keeps working on page text under notes
    e.preventDefault();
    e.stopPropagation();
    this.set('select');
    await this.app.selection.select(view.index, hit.id);
    if (TEXT_TOOLS.has(name) && hit.type === 'FreeText') {
      this.app.selection.editContents(view, this.app.selection.annot);
      return true;
    }
    const box = this.app.selection.box;
    if (box && e.buttons === 1) this.app.selection.startDrag(e, view, this.app.selection.annot, box, false);
    return true;
  }

  dispatch(type, view, e) {
    const t = this.current;
    if (!t || !state.info) return;
    const pt = view.toPage(e);
    if (type === 'pointerdown' && view.annots && (ONE_SHOT.has(state.tool) || TEXT_TOOLS.has(state.tool)) && !PLACEMENT.has(state.tool)) {
      const hit = hitTest(view.annots, pt, 2);
      if (hit && !(state.tool === 'edittext' && hit.type !== 'FreeText')) { this.interceptExisting(view, pt, e); return; }
    }
    switch (type) {
      case 'pointerdown': t.onDown?.(view, pt, e); break;
      case 'pointermove': t.onMove?.(view, pt, e); break;
      case 'pointerup': t.onUp?.(view, pt, e); break;
      case 'pointercancel': t.onUp?.(view, null, e); break;
      case 'pointerleave': t.onLeave?.(view, e); break;
      case 'dblclick': t.onDblClick?.(view, pt, e); break;
      default: break;
    }
  }

  onKey(e) { return this.current?.onKey?.(e) || false; }

  /** Signature field clicked: sign straight into its rect. */
  async signIntoRect(page, rect) {
    if (!state.signature) {
      const sig = await createSignature();
      if (!sig) return;
      state.signature = sig;
    }
    await this.tools.signature.place(page, fitInto(state.signature, rect));
  }
}
