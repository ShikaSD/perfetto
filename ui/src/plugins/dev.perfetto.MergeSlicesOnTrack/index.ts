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

import m from 'mithril';
import {
  LONG,
  LONG_NULL,
  NUM,
  NUM_NULL,
  STR_NULL,
} from '../../trace_processor/query_result';
import type {Trace} from '../../public/trace';
import type {PerfettoPlugin} from '../../public/plugin';
import type {TrackRenderer} from '../../public/track';
import {SliceTrack, renderTooltip} from '../../components/tracks/slice_track';
import {SourceDataset} from '../../trace_processor/dataset';
import {createPerfettoTable} from '../../trace_processor/sql_utils';
import {clamp} from '../../base/math_utils';
import {BigintMath as BIMath} from '../../base/bigint_math';
import {exists} from '../../base/utils';
import {getColorForSlice} from '../../components/colorizer';

const schema = {
  id: NUM,
  ts: LONG,
  dur: LONG,
  name: STR_NULL,
  depth: NUM,
  thread_dur: LONG_NULL,
  category: STR_NULL,
  correlation_id: STR_NULL,
  arg_set_id: NUM_NULL,
  track_id: NUM,
};

export default class MergeSlicesOnTrack implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.MergeSlicesOnTrack';

  async onTraceLoad(ctx: Trace): Promise<void> {
    ctx.onTraceReady.addListener(async () => {
      await this.mergeSlicesIntoExistingTracks(ctx);
    });
  }

  private async mergeSlicesIntoExistingTracks(ctx: Trace): Promise<void> {
    const e = ctx.engine;

    // Find all threads (utid) that have multiple slice tracks across imported traces.
    const multiTrackThreadsRes = await e.query(`
      SELECT tt.utid, group_concat(DISTINCT s.track_id ORDER BY s.track_id ASC) AS track_ids
      FROM thread_track tt
      JOIN slice s ON s.track_id = tt.id
      GROUP BY tt.utid
      HAVING count(DISTINCT s.track_id) > 1
    `);

    let workspaceChanged = false;

    for (
      const iter = multiTrackThreadsRes.iter({utid: NUM, track_ids: STR_NULL});
      iter.valid();
      iter.next()
    ) {
      if (!iter.track_ids) continue;
      const allMatchingTrackIds = iter.track_ids
        .split(',')
        .map((id) => Number(id.trim()))
        .filter((id) => !isNaN(id));

      if (allMatchingTrackIds.length <= 1) continue;

      const primaryTrackId = allMatchingTrackIds[0];
      const primaryTrackUri = `/slice_${primaryTrackId}`;

      // Locate the existing registered track from the first trace file.
      const primaryTrack = ctx.tracks.getTrack(primaryTrackUri);
      if (!primaryTrack) continue;

      // Query slices across all matching tracks interleaved by timestamp
      const slicesRes = await e.query(`
        SELECT id, ts, dur
        FROM slice
        WHERE track_id IN (${allMatchingTrackIds.join(',')})
        ORDER BY ts ASC, dur DESC
      `);

      // Re-parent / interleave slices by timestamp so enclosing parent spans
      // naturally form a merged callstack tree hierarchy.
      const depthEntries: Array<[number, number]> = [];
      const stack: Array<{end: bigint; depth: number}> = [];
      let maxDepth = 0;

      for (
        const sliceIter = slicesRes.iter({id: NUM, ts: LONG, dur: LONG});
        sliceIter.valid();
        sliceIter.next()
      ) {
        const id = sliceIter.id;
        const ts = sliceIter.ts;
        const dur = sliceIter.dur;
        const end = ts + (dur > 0n ? dur : 1n);

        while (stack.length > 0 && stack[stack.length - 1].end <= ts) {
          stack.pop();
        }

        const depth = stack.length > 0 ? stack[stack.length - 1].depth + 1 : 0;
        depthEntries.push([id, depth]);
        if (depth > maxDepth) {
          maxDepth = depth;
        }

        stack.push({end, depth});
      }

      // Materialize interleaved tree depths in a Perfetto SQL table
      const layoutTableName = `__interleaved_slice_depth_${primaryTrackId}`;
      const valuesClause =
        depthEntries.length > 0
          ? depthEntries.map(([id, d]) => `(${id}, ${d})`).join(',\n')
          : '(0, 0)';

      await createPerfettoTable({
        name: layoutTableName,
        engine: e,
        as: `
          WITH values_table(id, depth) AS (
            VALUES ${valuesClause}
          )
          SELECT id, depth FROM values_table
        `,
      });

      const mergedDataset = new SourceDataset({
        schema,
        select: {
          id: 'id',
          ts: 'ts',
          dur: 'dur',
          depth: {
            join: 'depth',
            expr: 'depth.depth',
          },
          name: 'name',
          thread_dur: 'thread_dur',
          track_id: 'track_id',
          category: 'category',
          correlation_id: "extract_arg(arg_set_id, 'correlation_id')",
          arg_set_id: 'arg_set_id',
        },
        src: 'slice',
        joins: {
          depth: {
            from: `${layoutTableName} USING (id)`,
            unique: true,
          },
        },
        filter: {
          col: 'track_id',
          in: allMatchingTrackIds,
        },
      });

      const mergedRenderer = SliceTrack.create({
        trace: ctx,
        uri: primaryTrackUri,
        dataset: mergedDataset,
        initialMaxDepth: maxDepth,
        sliceName: (row) => (row.name === null ? '[null]' : row.name),
        rootTableName: 'slice',
        fillRatio: (row) => {
          if (row.dur > 0n && row.thread_dur !== null) {
            return clamp(BIMath.ratio(row.thread_dur, row.dur), 0, 1);
          } else {
            return 1;
          }
        },
        tooltip: (slice) => {
          return renderTooltip(ctx, slice, {
            title: slice.title,
            extras:
              exists(slice.row.category) &&
              m('', 'Category: ', slice.row.category),
          });
        },
        colorizer: (row) => {
          if (row.correlation_id) {
            return getColorForSlice(row.correlation_id, {
              stripTrailingDigits: false,
            });
          }
          if (row.name) {
            return getColorForSlice(row.name);
          }
          return getColorForSlice(`${row.id}`);
        },
      });

      // Modify existing track from first trace file in place to render merged slices.
      (primaryTrack as {renderer: TrackRenderer}).renderer = mergedRenderer;

      // Remove secondary duplicate track nodes from subsequent trace files.
      for (let i = 1; i < allMatchingTrackIds.length; i++) {
        const secondaryId = allMatchingTrackIds[i];
        const secondaryUri = `/slice_${secondaryId}`;
        const secondaryNodes = ctx.defaultWorkspace.flatTracks.filter(
          (t) => t.uri === secondaryUri,
        );
        for (const node of secondaryNodes) {
          node.remove();
          workspaceChanged = true;
        }
      }
    }

    if (workspaceChanged) {
      m.redraw();
    }
  }
}
