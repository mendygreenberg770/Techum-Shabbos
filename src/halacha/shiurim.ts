/**
 * Shiurim per Reb Chaim Naeh (R' Avraham Chaim Naeh).
 *
 * The halachic basis of the app is Shulchan Aruch HaRav (Alter Rebbe)
 * OC 396-408 where extant, and Ketzos HaShulchan for the rest of
 * hilchos eiruvei techumin (409-416). See DESIGN.md.
 */

/** One amah per Reb Chaim Naeh, in meters. */
export const AMAH_M = 0.48;

/** The techum: 2,000 amos. */
export const TECHUM_AMOS = 2000;
export const TECHUM_M = TECHUM_AMOS * AMAH_M; // 960 m

/**
 * Karpef / joining distance: 70 and 2/3 amos.
 * A house within this distance of the city joins the city (SA HaRav 398).
 */
export const KARPEF_AMOS = 70 + 2 / 3;
export const KARPEF_M = KARPEF_AMOS * AMAH_M; // 33.92 m

/**
 * Two cities join when within two karpefs (141 1/3 amos) of each other.
 */
export const TWO_CITIES_JOIN_M = 2 * KARPEF_M; // 67.84 m

/** Distance to the techum corner along the diagonal (2000 * sqrt(2) amos). */
export const TECHUM_CORNER_M = TECHUM_M * Math.SQRT2; // ~1357.6 m

/**
 * Four amos: what crossing a fully-swallowed city (ir muvla'as bitoch
 * hatechum) consumes of the 2,000-amah measure (SA HaRav 408:1).
 */
export const FOUR_AMOS_M = 4 * AMAH_M; // 1.92 m
