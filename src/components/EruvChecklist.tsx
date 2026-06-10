/**
 * Conditions for a valid eiruv techumin, per Ketzos HaShulchan
 * (hilchos eiruvei techumin; most of SA 409-416 is not extant in
 * Shulchan Aruch HaRav). Guidance only — details (the food's shiur,
 * validity of the resting spot) should be confirmed with a rav.
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
          Food: bread sufficient for <b>two meals</b>, or an accompaniment
          (lifsan) eaten with two meals — per the shiurim of Reb Chaim Naeh.
        </li>
        <li>
          The spot must be one where you <b>could halachically access and eat
          the food</b> at bein hashmashos (not locked away from you, not a
          place forbidden to you).
        </li>
        <li>
          One may only place an eiruv <b>for the sake of a mitzvah or a
          similar need</b> (e.g., a simchah, greeting one's rebbi).
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
      </ul>
    </details>
  );
}
