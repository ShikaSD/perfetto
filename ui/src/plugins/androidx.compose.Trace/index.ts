// Copyright (C) 2025 The Android Open Source Project
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

import {Trace} from '../../public/trace';
import {Tab} from '../../public/tab';
import {MetricVisualisation} from '../../public/plugin';
import {PerfettoPlugin} from '../../public/plugin';
import m from 'mithril';
import {DetailsShell} from '../../widgets/details_shell';
import {STR} from '../..//trace_processor/query_result';
import {GridLayout} from '../../widgets/grid_layout';
import {Section} from '../../widgets/section';
import {Tree, TreeNode} from '../../widgets/tree';

// Rename this class to match your plugin.
export default class implements PerfettoPlugin {
  static readonly id = 'androidx.compose.Trace';

  async onTraceLoad(trace: Trace): Promise<void> {
    trace.tabs.registerTab({
      uri: `${trace.pluginId}#tab`,
      content: new ComposeTab(trace),
    });

    trace.tabs.showTab(`${trace.pluginId}#tab`);
  }

  static metricVisualisations(): MetricVisualisation[] {
    return [];
  }
}

interface ComposeTabData {
  eventId: number;
  slice?: ComposeSliceData | null;
}

interface ComposeSliceData {
  name: string;
  data: ComposeFunctionMeta | ComposeRecomposeRoot;
}

interface ComposeFunctionMeta {
  kind: 'function';
  dirty: [number, number];
  reads: ComposeStateRead[];
}

interface ComposeStateRead {
  name: string;
  reads: string[];
}

interface ComposeRecomposeRoot {
  kind: 'recompose_root';
  states: ComposeStateRead[];
}

class ComposeTab implements Tab {
  private trace: Trace;
  private data: ComposeTabData | null = null;
  public selectedStateRead: number | null = null;

  constructor(trace: Trace) {
    this.trace = trace;
  }

  getTitle(): string {
    return 'Compose';
  }

  render(): m.Children {
    const selection = this.trace.selection.selection;

    if (
      selection.kind == 'track_event' &&
      this.data?.eventId != selection.eventId
    ) {
      this.data = {eventId: selection.eventId};
      loadSlice(this.trace, selection.eventId).then((details) => {
        if (details && this.data?.eventId == selection.eventId) {
          this.data.slice = details;
          m.redraw();
        } else if (this.data?.eventId == selection.eventId) {
          this.data.slice = null;
        }
      });
    }
    if (!this.data || this.data.slice == null) {
      return m(DetailsShell, {
        title: 'No Compose debug info for selection',
      });
    }
    return m(
      DetailsShell,
      {
        title: this.data.slice.name,
      },
      this.data.slice.data.kind === 'recompose_root'
        ? renderRecomposeRoot(this.data.slice.data, this)
        : renderFunction(this.data.slice.data as ComposeFunctionMeta, this),
    );
  }
}

function renderRecomposeRoot(
  data: ComposeRecomposeRoot,
  tab: ComposeTab,
): m.Children {
  return m(
    GridLayout,
    m(
      Section,
      {title: 'Invalidations'},
      m(
        Tree,
        data.states.map((read, index) =>
          m(TreeNode, {
            left: m(
              'div',
              {
                onclick: () => {
                  tab.selectedStateRead = index;
                  m.redraw();
                },
              },
              read.name,
            ),
            right: read.reads.length.toString(),
          }),
        ),
      ),
    ),
    m(
      Section,
      {title: 'State Read Details'},
      tab.selectedStateRead !== null
        ? m(
            Tree,
            data.states[tab.selectedStateRead].reads?.map((value) =>
              m(TreeNode, value),
            ),
          )
        : m('.empty-state', 'Select a state read to view details'),
    ),
  );
}

function renderFunction(
  data: ComposeFunctionMeta,
  tab: ComposeTab,
): m.Children {
  return m(
    GridLayout,
    m(
      Section,
      {title: 'Function Details'},
      m(
        Tree,
        renderDirtyState(data.dirty),
        m(TreeNode, {
          left: 'Forced:',
          right: data.dirty[0] & 0b1 ? 'true' : 'false',
        }),
        m(
          TreeNode,
          {
            left: 'State Reads',
            right: data.reads
              .reduce((acc, read) => acc + read.reads.length, 0)
              .toString(),
            startsCollapsed: true,
            showCaret: true,
          },
          data.reads.map((read, index) =>
            m(TreeNode, {
              left: m(
                'div',
                {
                  onclick: () => {
                    tab.selectedStateRead = index;
                    m.redraw();
                  },
                },
                read.name,
              ),
              right: read.reads.length.toString(),
            }),
          ),
        ),
      ),
    ),
    m(
      Section,
      {title: 'State Read Details'},
      tab.selectedStateRead !== null
        ? m(
            Tree,
            data.reads[tab.selectedStateRead].reads?.map((value, i) =>
              m(TreeNode, {left: `State read ${i}`}, m('pre', value)),
            ),
          )
        : m('', 'Select a state read to view details'),
    ),
  );
}

function renderDirtyState(dirty: [number, number]): m.Children {
  const params = dirty.flatMap((param) => dirtyToString(param));
  return m(
    TreeNode,
    {
      startsCollapsed: true,
      showCaret: true,
      left: 'Parameters',
      summary: JSON.stringify(params),
    },
    params.map((p, i) => m(TreeNode, {left: `${i}:`, right: p})),
  );
}

function dirtyToString(dirty: number): string[] {
  const result: string[] = [];
  if (dirty == -1) {
    return result;
  }
  dirty = dirty >> 1;
  while (dirty > 0) {
    const state = dirty & 0b011;
    switch (state) {
      case 0b000:
        result.push('Unknown');
        break;
      case 0b001:
        result.push('Same');
        break;
      case 0b010:
        result.push('Different');
        break;
      case 0b011:
        result.push('Static');
        break;
      default:
        result.push(`Invalid state: ${state}`);
        break;
    }
    dirty = dirty >> 3;
  }

  return result;
}

async function loadSlice(
  trace: Trace,
  eventId: number,
): Promise<ComposeSliceData | undefined> {
  const results = await trace.engine.query(
    `select 
      slices.name as name, 
      args.key as key, 
      args.string_value as debugInfo 
    from slices 
    join args on 
      slices.arg_set_id = args.arg_set_id
    and slices.id = ${eventId} 
    and args.key = 'debug.debugInfo'`,
  );
  const iter = results.iter({
    name: STR,
    debugInfo: STR,
  });

  if (iter.valid()) {
    const name = iter.name;
    const value = iter.debugInfo;

    if (name == 'Recompose root') {
      const stateReads = parseRecomposeRoot(value);
      return {
        name,
        data: {
          kind: 'recompose_root',
          states: stateReads,
        },
      };
    }

    if (name.startsWith('State read of ')) {
      return;
    }

    const stateReadsResults = await trace.engine.query(
      `select 
        slices.name as name,
        args.key as key,
        args.string_value as debugInfo from slices 
      join args on slices.arg_set_id = args.arg_set_id 
      where slices.name like "State read of %" 
      and slices.parent_id = ${eventId} 
      and args.key = 'debug.debugInfo'`,
    );

    const stateReadIter = stateReadsResults.iter({
      name: STR,
      debugInfo: STR,
    });

    let stateReads: ComposeStateRead[] = [];
    while (stateReadIter.valid()) {
      stateReads.push({
        name: stateReadIter.name.replace('State read of ', ''),
        reads: parseException(stateReadIter.debugInfo),
      });
      stateReadIter.next();
    }

    // associate state reads by name
    const stateReadsMap = new Map<string, string[]>();
    for (const stateRead of stateReads) {
      const reads = stateReadsMap.get(stateRead.name) || [];
      reads.push(...stateRead.reads);
      stateReadsMap.set(stateRead.name, reads);
    }
    stateReads = [];
    for (const [name, reads] of stateReadsMap.entries()) {
      stateReads.push({
        name,
        reads,
      });
    }

    const data = JSON.parse(value) as ComposeFunctionMeta;
    data.reads = stateReads;
    return {
      name,
      data,
    };
  }

  return;
}

function parseException(debugInfo: string): string[] {
  const result: string[] = [];
  const lines = debugInfo.split('\n');
  for (const line of lines) {
    result.push(line.replace('\t', ''));
  }
  return result.join('\n').split('---');
}

function parseRecomposeRoot(debugInfo: string): ComposeStateRead[] {
  if (debugInfo.length == 0) return [];

  const lines = debugInfo.split('\n').filter((line) => line.length > 0);
  const entries: ComposeStateRead[] = [];

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    if (!lines[lineIndex].startsWith('state instance:')) {
      throw new Error(
        `Failed to parse recompose root, found ${lines[lineIndex]}`,
      );
    }
    lineIndex++;
    const read: ComposeStateRead = {name: lines[lineIndex], reads: []};
    lineIndex++;

    let trace = '';
    while (lineIndex < lines.length && lines[lineIndex].startsWith('---')) {
      lineIndex++;
      while (lineIndex < lines.length && lines[lineIndex].startsWith('\tat')) {
        trace += lines[lineIndex];
        trace += '\n';
        lineIndex++;
      }
      read.reads.push(trace);
      trace = '';
    }
    entries.push(read);
  }

  return entries;
}
