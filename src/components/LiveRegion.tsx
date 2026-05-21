// ARIA live region host (issue #177).
//
// Renders two visually-hidden elements — one `aria-live="polite"`, one
// `aria-live="assertive"` — and subscribes to the `announce()` channel in
// src/store/announce.ts. When a message arrives it is written into the
// matching region; screen readers (NVDA / JAWS / Narrator) then speak it.
//
// Implementation notes:
//   - The element text is cleared briefly before the new message is written.
//     Screen readers only re-announce a region when its text content
//     *changes*; without the clear, two identical consecutive messages
//     (e.g. moving back to the same cell) would be silent.
//   - The regions are kept in the accessibility tree (not display:none) via
//     the `.coco-visually-hidden` clip pattern, so assistive tech still reads
//     them while sighted users see nothing.

import { useEffect, useState } from "react";
import { subscribeAnnouncements } from "../store/announce";
import "./LiveRegion.css";

export default function LiveRegion() {
  const [polite, setPolite] = useState("");
  const [assertive, setAssertive] = useState("");

  useEffect(() => {
    // #177 review m1: separate timers per channel. A shared timer let an
    // assertive message arriving shortly after a polite one cancel the
    // polite write, so the polite message was never spoken.
    let politeTimer: ReturnType<typeof setTimeout> | undefined;
    let assertiveTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribeAnnouncements(({ message, politeness }) => {
      const isAssertive = politeness === "assertive";
      const setter = isAssertive ? setAssertive : setPolite;
      // Clear first so an identical repeat message still triggers a re-read.
      setter("");
      if (isAssertive) {
        if (assertiveTimer) clearTimeout(assertiveTimer);
        assertiveTimer = setTimeout(() => setter(message), 60);
      } else {
        if (politeTimer) clearTimeout(politeTimer);
        politeTimer = setTimeout(() => setter(message), 60);
      }
    });
    return () => {
      unsubscribe();
      if (politeTimer) clearTimeout(politeTimer);
      if (assertiveTimer) clearTimeout(assertiveTimer);
    };
  }, []);

  return (
    <>
      <div
        className="coco-visually-hidden"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="live-region-polite"
      >
        {polite}
      </div>
      <div
        className="coco-visually-hidden"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        data-testid="live-region-assertive"
      >
        {assertive}
      </div>
    </>
  );
}
