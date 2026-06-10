/**
 * Conditions for a valid eiruv techumin. Most of SA 409-416 is not
 * extant in Shulchan Aruch HaRav, so these follow the Mechaber/Rama
 * with the Ketzos HaShulchan (and accepted poskim). Guidance only —
 * details (the food's shiur, validity of the resting spot) should be
 * confirmed with a rav.
 */
export default function EruvChecklist() {
  return (
    <details className="checklist">
      <summary>Eiruv techumin — checklist &amp; nusach</summary>
      <ul>
        <li>
          Place the eiruv <b>before Shabbos</b>; it must exist and be fit to
          eat during bein hashmashos.
        </li>
        <li>
          Food: bread sufficient for <b>two meals</b> — commonly reckoned at
          the volume of six to eight beitzim (≈ 346–461 cm³ per Reb Chaim
          Naeh's beitzah of 57.6 cm³) — or an accompaniment (lifsan) eaten
          with two meals. Confirm the exact quantity with your rav.
        </li>
        <li>
          The eiruv must rest <b>outside your town</b> (and outside its
          70⅔-amah margin) — within your own town it has no effect — and
          within 2,000 amos of the town, at a <b>single defined spot</b>.
        </li>
        <li>
          The spot must be one where you <b>could halachically access and eat
          the food</b> at bein hashmashos (not locked away from you, not
          requiring a forbidden act to reach). An eiruv placed in a{" "}
          <b>cemetery</b> is invalid, since benefit from it is forbidden
          (SA 409:1).
        </li>
        <li>
          One may only place an eiruv <b>for the sake of a mitzvah or a
          similar need</b> (e.g., a simchah, greeting one's rebbi)
          (SA 415:1).
        </li>
        <li>
          <b>Traveler's declaration:</b> one on the road before Shabbos may
          acquire shevisa by declaration — naming a known spot (e.g., a tree
          or landmark) within 2,000 amos that he could reach before
          nightfall: "shevisasi b'makom ploni" (SA 409).
        </li>
        <li>
          <b>Conditional eiruvin:</b> one may deposit two eiruvin in opposite
          directions and stipulate which takes effect (e.g., depending on
          where the need arises) (SA 413).
        </li>
        <li>
          <b>Two-day Yom Tov:</b> the eiruv must exist at the onset of{" "}
          <i>each</i> day — place two eiruvin or ensure the food remains
          intact for the second evening (SA 416).
        </li>
        <li>
          <b>Brachah:</b>{" "}
          <span dir="rtl" lang="he">
            בָּרוּךְ אַתָּה ה׳ אֱלֹקֵינוּ מֶלֶךְ הָעוֹלָם אֲשֶׁר קִדְּשָׁנוּ
            בְּמִצְוֹתָיו וְצִוָּנוּ עַל מִצְוַת עֵרוּב
          </span>
        </li>
        <li>
          <b>Declaration:</b>{" "}
          <span dir="rtl" lang="he">
            בְּזֶה הָעֵרוּב יְהֵא מֻתָּר לִי לֵילֵךְ מִמָּקוֹם זֶה אַלְפַּיִם
            אַמָּה לְכָל רוּחַ
          </span>
        </li>
        <li>
          <b>Alternative (kinyan shevisa b'raglav):</b> being physically
          present at the spot at bein hashmashos with intent to acquire one's
          shevisa there — no food or brachah is needed.
        </li>
        <li>
          <b>A practical caution:</b> even where the map shows a feasible
          route, the local rabbanim may rule that it cannot be relied on in
          practice (for example, the London Beth Din's position on walking
          between Borehamwood and Edgware, the case discussed in the article
          this planner draws on). Always confirm the route, the spot's
          accessibility, and its halachic validity with your rav.
        </li>
      </ul>
    </details>
  );
}
