import { describe, expect, it } from 'vitest';
import '../../../../../src/view/canvas/test-canvas-env';
import { ARC_ADJUSTMENTS, buildArc } from '../../../../../src/view/canvas/shapes/basic/arc';
import { BLOCK_ARC_ADJUSTMENTS, buildBlockArc } from '../../../../../src/view/canvas/shapes/basic/block-arc';
import { CHORD_ADJUSTMENTS, buildChord } from '../../../../../src/view/canvas/shapes/basic/chord';
import { buildCube, CUBE_ADJUSTMENTS } from '../../../../../src/view/canvas/shapes/basic/cube';
import { buildPie, PIE_ADJUSTMENTS } from '../../../../../src/view/canvas/shapes/basic/pie';
import { buildCan, buildCanFaces, CAN_HANDLES } from '../../../../../src/view/canvas/shapes/basic/can';
import { buildCorner, CORNER_HANDLES } from '../../../../../src/view/canvas/shapes/basic/corner';
import { buildHalfFrame, HALF_FRAME_HANDLES } from '../../../../../src/view/canvas/shapes/basic/half-frame';
import { buildHexagon, HEXAGON_HANDLES } from '../../../../../src/view/canvas/shapes/basic/hexagon';
import { buildLeftBrace } from '../../../../../src/view/canvas/shapes/basic/left-brace';
import { buildLeftBracket, LEFT_BRACKET_HANDLES } from '../../../../../src/view/canvas/shapes/basic/left-bracket';
import { buildParallelogram } from '../../../../../src/view/canvas/shapes/basic/parallelogram';
import { buildTrapezoid } from '../../../../../src/view/canvas/shapes/basic/trapezoid';
import { buildFoldedCorner } from '../../../../../src/view/canvas/shapes/basic/folded-corner';
import { buildFrame } from '../../../../../src/view/canvas/shapes/basic/frame';
import { buildNoSmoking } from '../../../../../src/view/canvas/shapes/basic/no-smoking';
import { buildOctagon } from '../../../../../src/view/canvas/shapes/basic/octagon';
import { buildPlaque } from '../../../../../src/view/canvas/shapes/basic/plaque';
import { buildPlus } from '../../../../../src/view/canvas/shapes/basic/plus';
import { buildRound1Rect } from '../../../../../src/view/canvas/shapes/basic/round1-rect';
import { buildRound2DiagRect } from '../../../../../src/view/canvas/shapes/basic/round2-diag-rect';
import { buildRound2SameRect } from '../../../../../src/view/canvas/shapes/basic/round2-same-rect';
import { buildSmileyFace } from '../../../../../src/view/canvas/shapes/basic/smiley-face';
import { buildSnipRoundRect } from '../../../../../src/view/canvas/shapes/basic/snip-round-rect';
import { buildSnip1Rect } from '../../../../../src/view/canvas/shapes/basic/snip1-rect';
import { buildSnip2DiagRect } from '../../../../../src/view/canvas/shapes/basic/snip2-diag-rect';
import { buildSnip2SameRect } from '../../../../../src/view/canvas/shapes/basic/snip2-same-rect';
import { buildTriangle } from '../../../../../src/view/canvas/shapes/basic/triangle';
import { RIGHT_BRACKET_HANDLES } from '../../../../../src/view/canvas/shapes/basic/right-bracket';

const OOXML_LAST_ANGLE = 21_599_999;

type RecordedPath = Path2D & {
  finalize(): void;
  ops: readonly unknown[];
};

function recordedOps(path: Path2D): readonly unknown[] {
  const recorded = path as RecordedPath;
  recorded.finalize();
  return recorded.ops;
}

describe('OOXML preset adjustment boundaries', () => {
  it.each([
    ['arc', ARC_ADJUSTMENTS],
    ['blockArc', BLOCK_ARC_ADJUSTMENTS],
    ['chord', CHORD_ADJUSTMENTS],
    ['pie', PIE_ADJUSTMENTS],
  ] as const)('%s excludes the full-turn endpoint for both angle adjustments', (_kind, specs) => {
    expect(specs[0].max).toBe(OOXML_LAST_ANGLE);
    expect(specs[1].max).toBe(OOXML_LAST_ANGLE);
  });

  it('cube exposes the complete preset depth domain', () => {
    expect(CUBE_ADJUSTMENTS[0]).toMatchObject({ min: 0, max: 100000 });
    expect(recordedOps(buildCube({ w: 100, h: 100 }, [100001]))).toEqual(
      recordedOps(buildCube({ w: 100, h: 100 }, [100000])),
    );
  });

  it.each([
    ['arc', buildArc],
    ['blockArc', buildBlockArc],
    ['chord', buildChord],
    ['pie', buildPie],
  ] as const)('%s projects imported full-turn values to the last valid angle', (_kind, build) => {
    const frame = { w: 100, h: 100 };
    expect(recordedOps(build(frame, [21_600_000, 0]))).toEqual(
      recordedOps(build(frame, [OOXML_LAST_ANGLE, 0])),
    );
  });

  it.each([
    ['can', buildCan, { w: 100, h: 200 }, [-1], [0], [100001], [100000]],
    ['corner', buildCorner, { w: 100, h: 200 }, [-1, -1], [0, 0], [200001, 100001], [200000, 100000]],
    ['halfFrame', buildHalfFrame, { w: 200, h: 100 }, [-1, 33333], [0, 33333], [83334, 200001], [83333.5, 200000]],
    ['hexagon', buildHexagon, { w: 200, h: 100 }, [-1], [0], [100001], [100000]],
    ['leftBrace', buildLeftBrace, { w: 100, h: 200 }, [-1, -1], [0, 0], [50001, 100001], [0, 100000]],
    ['leftBracket', buildLeftBracket, { w: 100, h: 200 }, [-1], [0], [100001], [100000]],
    ['parallelogram', buildParallelogram, { w: 200, h: 100 }, [-1], [0], [200001], [200000]],
    ['trapezoid', buildTrapezoid, { w: 200, h: 100 }, [-1], [0], [100001], [100000]],
  ] as const)('%s evaluates imported values through its preset pin guides',
  (_kind, build, frame, below, atMin, above, atMax) => {
    expect(recordedOps(build(frame, [...below]))).toEqual(recordedOps(build(frame, [...atMin])));
    expect(recordedOps(build(frame, [...above]))).toEqual(recordedOps(build(frame, [...atMax])));
  });

  it('uses the same pinned can guide for silhouette, faces, and handle', () => {
    const frame = { w: 100, h: 200 };
    expect(recordedOps(buildCanFaces(frame, [100001])[0].path)).toEqual(
      recordedOps(buildCanFaces(frame, [100000])[0].path),
    );
    expect(CAN_HANDLES[0].position(frame, [100001])).toEqual(
      CAN_HANDLES[0].position(frame, [100000]),
    );
  });

  it.each([
    ['foldedCorner', buildFoldedCorner, [-1], [0], [50001], [50000]],
    ['frame', buildFrame, [-1], [0], [50001], [50000]],
    ['noSmoking', buildNoSmoking, [-1], [0], [50001], [50000]],
    ['octagon', buildOctagon, [-1], [0], [50001], [50000]],
    ['plaque', buildPlaque, [-1], [0], [50001], [50000]],
    ['plus', buildPlus, [-1], [0], [50001], [50000]],
    ['round1Rect', buildRound1Rect, [-1], [0], [50001], [50000]],
    ['round2DiagRect', buildRound2DiagRect, [-1, -1], [0, 0], [50001, 50001], [50000, 50000]],
    ['round2SameRect', buildRound2SameRect, [-1, -1], [0, 0], [50001, 50001], [50000, 50000]],
    ['smileyFace', buildSmileyFace, [-4654], [-4653], [4654], [4653]],
    ['snipRoundRect', buildSnipRoundRect, [-1, -1], [0, 0], [50001, 50001], [50000, 50000]],
    ['snip1Rect', buildSnip1Rect, [-1], [0], [50001], [50000]],
    ['snip2DiagRect', buildSnip2DiagRect, [-1, -1], [0, 0], [50001, 50001], [50000, 50000]],
    ['snip2SameRect', buildSnip2SameRect, [-1, -1], [0, 0], [50001, 50001], [50000, 50000]],
    ['triangle', buildTriangle, [-1], [0], [100001], [100000]],
  ] as const)('%s pins raw imported values only while evaluating its preset path',
  (_kind, build, below, atMin, above, atMax) => {
    const frame = { w: 160, h: 100 };
    expect(recordedOps(build(frame, [...below]))).toEqual(recordedOps(build(frame, [...atMin])));
    expect(recordedOps(build(frame, [...above]))).toEqual(recordedOps(build(frame, [...atMax])));
  });

  it('lets dynamic handles reach their exact frame and sibling-derived maxima', () => {
    expect(CORNER_HANDLES[0].apply({ w: 100, h: 200 }, [0, 0], { x: 0, y: 0 })[0]).toBe(200000);
    expect(HEXAGON_HANDLES[0].apply({ w: 200, h: 100 }, [0], { x: 200, y: 0 })[0]).toBe(100000);
    expect(LEFT_BRACKET_HANDLES[0].apply({ w: 100, h: 200 }, [0], { x: 0, y: 100 })[0]).toBe(100000);
    expect(RIGHT_BRACKET_HANDLES[0].apply({ w: 100, h: 200 }, [0], { x: 100, y: 100 })[0]).toBe(100000);
    expect(HALF_FRAME_HANDLES[0].apply(
      { w: 200, h: 100 }, [0, 100000], { x: 0, y: 50 },
    )[0]).toBe(50000);
  });
});
