interface Props {
  usingCity: boolean;
  karpefOn: boolean;
  clusterSize?: number;
  totalBuildings?: number;
  bumpsCount: number;
  partialsCount: number;
  eruvOn: boolean;
}

/**
 * Walks the user through the calculation with sources, including where
 * other opinions exist. The app itself shows one line per din (the
 * accepted practice); this panel is where the alternatives live.
 */
export default function ExplainPanel({
  usingCity,
  karpefOn,
  clusterSize,
  totalBuildings,
  bumpsCount,
  partialsCount,
  eruvOn,
}: Props) {
  return (
    <details className="checklist">
      <summary>How this was calculated — sources &amp; other opinions</summary>
      <ul>
        <li>
          <b>Shiurim.</b> This app follows Reb Chaim Naeh: an amah is 48 cm,
          so 2,000 amos = 960 m, and 70⅔ amos = 33.92 m. Other shiurim
          exist — notably the Chazon Ish's amah of ~57.7 cm, which would
          give a techum of ~1,153 m. All boundaries shown scale to the
          chosen amah.
        </li>
        <li>
          <b>The town.</b> The techum applies only outside a built-up area:
          a town counts as 4 amos and the 2,000 are measured from its edge.
          A house within 70⅔ amos of the town extends it (ibur ha'ir), and
          chains onward; two towns join when their 70⅔-amah margins overlap
          (141⅓ amos total). Roads, railways, and rivers do not split a
          town — only the measured gap matters (SA HaRav 398).
          {usingCity && clusterSize != null && totalBuildings != null && (
            <>
              {" "}
              Here, {clusterSize.toLocaleString()} of{" "}
              {totalBuildings.toLocaleString()} analyzed buildings join your
              town.
            </>
          )}
          {" "}A lone house beyond the margin grants nothing — it does not
          restart the 2,000.
        </li>
        <li>
          <b>Squaring.</b> The town is squared as a north-aligned rectangle
          — ribua ha'olam, so that everyone squares the same town
          identically — and open space inside the rectangle counts as built
          (SA HaRav 398). Limit: in a bow-shaped town, open stretches whose
          flanking built ends are more than 4,000 amos apart may not be
          "filled in" by squaring (Mishnah Eruvin 55a; Nesivos Shabbos
          42:17) — the app warns when it detects this.
        </li>
        <li>
          <b>Karpef.</b> Whether a <i>single</i> town is granted an extra
          70⅔ amos before measuring is a machlokes in SA 398:5: the
          Mechaber grants it only between two towns; yesh omrim grant it to
          a single town as well. The app currently{" "}
          {karpefOn ? "includes" : "does not include"} it; the other
          opinion's boundary is drawn in gray so both are always visible.
        </li>
        <li>
          <b>The techum.</b> 2,000 amos in each direction from the squared
          edge, and the techum itself is squared — so the corners reach
          2,000·√2 ≈ 2,828 amos (SA HaRav 398–399).
        </li>
        <li>
          <b>Neighboring towns.</b> A town that lies <i>entirely</i> within
          the techum counts as only 4 amos, and the techum extends beyond
          it (SA HaRav 408:1)
          {bumpsCount > 0 && <> — applied to {bumpsCount} here</>}. But if
          the 2,000 end <i>mid-town</i>, one may walk only up to the line
          (kalsa midaso, 408:1)
          {partialsCount > 0 && <> — the red-outlined towns here</>}.
        </li>
        {eruvOn && (
          <>
            <li>
              <b>Eiruv techumin.</b> Food for two meals deposited before
              Shabbos within 2,000 amos of the town makes that spot one's
              residence: 2,000 amos in each direction around it, squared
              (SA HaRav 408). An eiruv resting <i>inside</i> a town makes
              one a resident of that town — the whole town is his 4 amos
              and the techum extends from its squared edge; inside one's{" "}
              <i>own</i> town it has no effect.
            </li>
            <li>
              <b>Your home town under an eiruv.</b> The app follows the
              Rashi/Rama view (408:1): since you physically spend the onset
              of Shabbos in your town, the entire town remains yours as 4
              amos even when it is not fully within the eiruv's techum —
              this is the common practice. Other opinions: the Mechaber is
              stricter (only up to where the measure ends), and the Alter
              Rebbe's Siddur appears to follow the stricter view, while his
              Shulchan Aruch on this passage was never published past its
              opening. The app does <i>not</i> credit continuing beyond the
              town under this leniency (a stringency).
            </li>
            <li>
              <b>Corner kula.</b> A town's squaring is fixed to the
              directions of the world, but one's <i>personal</i> eiruv
              square may be plotted to one's own preference — rotating it
              diamond-wise aims a corner at the destination, extending
              reach there to 2,000·√2 amos (~1,357.6 m) at the cost of
              breadth in other directions. This is a kula; confirm with
              your rav before relying on it.
            </li>
          </>
        )}
        <li>
          <b>Accuracy.</b> Building data comes from OpenStreetMap and
          distances are aerial (map-based). Halachic land measurement (a
          50-amah rope, by an expert, with rules for hills and valleys —
          SA HaRav 399) is a hands-on process that may produce different
          results, especially in hilly terrain.
        </li>
      </ul>
    </details>
  );
}
