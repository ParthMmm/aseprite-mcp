// Argument checks shared by the program API, the draft and the raster helpers.

export const MAX_CANVAS = 4096;

export const messageOf = (e: unknown): string =>
  String(
    (typeof e === "object" && e !== null && "message" in e
      ? e.message
      : undefined) ?? e
  );

/** Throws "<label> must be a whole number >= <min>, got <value>." unless value is such a number. */
export const wholeNumber = (label: string, value: unknown, min = 1): number => {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(
      `${label} must be a whole number >= ${min}, got ${JSON.stringify(value)}.`
    );
  }
  return value;
};

const canvasSide = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= MAX_CANVAS;

export const checkCanvasSize = (
  label: string,
  w: unknown,
  h: unknown
): void => {
  if (!canvasSide(w) || !canvasSide(h)) {
    throw new Error(
      `${label}: whole numbers 1-${MAX_CANVAS}, got ${JSON.stringify(w)}, ${JSON.stringify(h)}.`
    );
  }
};
