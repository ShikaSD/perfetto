// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import type {PerfettoPlugin} from '../../public/plugin';
import type {Trace} from '../../public/trace';
import {Intent} from '../../widgets/common';
import {
  getTrackShellWidth,
  updateTrackShellWidth,
} from '../../components/tracks/track_helper';

const PLUGIN_ID = 'dev.perfetto.TrackIsolation';
const STYLE_ELEMENT_ID = 'pf-focus-mode-style';

const FOCUS_MODE_CSS = `
  body.pf-focus-mode {
    --track-shell-width: 0px !important;
  }
  body.pf-focus-mode .pf-track__header {
    grid-template-columns: 0 0 1fr !important;
  }
  body.pf-focus-mode .pf-topbar,
  body.pf-focus-mode .pf-timeline-page__overview,
  body.pf-focus-mode .pf-minimap,
  body.pf-focus-mode .pf-track__shell,
  body.pf-focus-mode .pf-track__header::before,
  body.pf-focus-mode .pf-resize-handle--horizontal,
  body.pf-focus-mode .pf-timeline-toolbar {
    display: none !important;
  }
`;

/**
 * Plugin that enables a distraction-free Focus Mode:
 * Hides top bar (search field), sidebar, minimap, and the entire left track/thread column,
 * while keeping the full-width timeline canvas and bottom selection drawer open.
 */
export default class TrackIsolationPlugin implements PerfettoPlugin {
  static readonly id = PLUGIN_ID;
  static readonly description =
    'Focus Mode: Hides top bar, sidebar, minimap, and whole thread/track column, keeping only full-width timeline and bottom selection drawer.';

  private focusModeActive = false;
  private previousSidebarVisible = true;
  private previousTrackShellWidth = 250;

  async onTraceLoad(trace: Trace): Promise<void> {
    this.ensureStyleSheetInstalled();

    // Register persistent status bar toggle item
    trace.statusbar.registerItem({
      renderItem: () => {
        if (!this.focusModeActive) {
          return {
            label: 'Focus Mode',
            icon: 'visibility',
            intent: Intent.None,
            onclick: () => this.enableFocusMode(trace),
          };
        }
        return {
          label: 'Focus Mode: ON (Click to restore UI)',
          icon: 'visibility_off',
          intent: Intent.Primary,
          onclick: () => this.disableFocusMode(trace),
        };
      },
    });

    // Toggle focus mode (Mod+Shift+F)
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#toggle`,
      name: 'Toggle Focus Mode (Hide top bar, sidebar, minimap, and whole thread column)',
      defaultHotkey: 'Mod+Shift+F',
      callback: () => {
        if (this.focusModeActive) {
          this.disableFocusMode(trace);
        } else {
          this.enableFocusMode(trace);
        }
      },
    });

    // Explicit command to enable focus mode
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#isolateSelected`,
      name: 'Enable Focus Mode (Full viewport timeline view)',
      callback: () => {
        this.enableFocusMode(trace);
      },
    });

    // Explicit command to restore normal UI
    trace.commands.registerCommand({
      id: `${PLUGIN_ID}#restoreAll`,
      name: 'Restore UI (Exit Focus Mode)',
      callback: () => {
        this.disableFocusMode(trace);
      },
    });
  }

  private enableFocusMode(trace: Trace): void {
    if (this.focusModeActive) return;

    // Save and hide sidebar
    this.previousSidebarVisible = trace.sidebar.visible;
    if (trace.sidebar.visible) {
      trace.sidebar.toggleVisibility();
    }

    // Save and update track shell width in JS & CSS so canvas draws from x = 0
    this.previousTrackShellWidth = getTrackShellWidth();
    updateTrackShellWidth(0);

    // Hide top bar, minimap overview, and whole thread/track column via CSS class
    document.body.classList.add('pf-focus-mode');

    this.focusModeActive = true;
    trace.raf.scheduleFullRedraw();
  }

  private disableFocusMode(trace: Trace): void {
    if (!this.focusModeActive) return;

    // Restore sidebar
    if (trace.sidebar.visible !== this.previousSidebarVisible) {
      trace.sidebar.toggleVisibility();
    }

    // Restore track shell width in JS & CSS
    updateTrackShellWidth(this.previousTrackShellWidth);

    // Restore top bar, minimap overview, and whole thread/track column
    document.body.classList.remove('pf-focus-mode');

    this.focusModeActive = false;
    trace.raf.scheduleFullRedraw();
  }

  private ensureStyleSheetInstalled(): void {
    if (document.getElementById(STYLE_ELEMENT_ID)) {
      return;
    }
    const styleEl = document.createElement('style');
    styleEl.id = STYLE_ELEMENT_ID;
    styleEl.textContent = FOCUS_MODE_CSS;
    document.head.appendChild(styleEl);
  }
}
