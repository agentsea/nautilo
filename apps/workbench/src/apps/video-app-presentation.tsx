import { Clapperboard } from "lucide-react";

/** Bundled first-party artwork, not a remote image or a user's document. */
export function VideoAppIcon({ className = "h-4 w-4" }: { className?: string }) {
  return <Clapperboard aria-label="Video editor" className={className} />;
}

/** An explicitly illustrative overview; never pretend this is a document preview. */
export function VideoAppPreview() {
  return (
    <figure data-testid="video-app-overview" className="overflow-hidden rounded-lg border border-border bg-background-element">
      <svg viewBox="0 0 800 450" role="img" aria-label="Video editor overview: media library, video canvas, clip properties and a multi-track timeline" className="block w-full">
        <rect width="800" height="450" fill="#151923" />
        <rect x="1" y="1" width="798" height="38" fill="#242936" />
        <g fill="#edf4f7" fontFamily="system-ui, sans-serif" fontSize="12">
          <text x="18" y="25" fontWeight="700">Video</text>
          <text x="100" y="25">Edit</text><text x="148" y="25" fill="#a6b2c5">Generate</text>
          <text x="667" y="25">Import</text><text x="729" y="25">Export</text>
        </g>
        <rect x="12" y="51" width="148" height="221" rx="6" fill="#242936" />
        <g fill="#bbc9d9" fontFamily="system-ui, sans-serif" fontSize="11">
          <text x="24" y="74">Media</text><text x="72" y="74">Transitions</text>
          <text x="24" y="171">Opening</text><text x="24" y="250">Detail</text>
        </g>
        <rect x="24" y="88" width="123" height="65" rx="4" fill="#a3c4c9" />
        <circle cx="85" cy="119" r="22" fill="#357fa1" />
        <rect x="24" y="184" width="123" height="48" rx="4" fill="#527989" />
        <circle cx="91" cy="209" r="28" fill="#357fa1" />
        <rect x="173" y="51" width="451" height="221" rx="6" fill="#0a1019" />
        <rect x="189" y="62" width="419" height="182" fill="#dce9e5" />
        <ellipse cx="398" cy="206" rx="76" ry="10" fill="#b8cec9" />
        <circle cx="398" cy="148" r="60" fill="#357fa1" />
        <circle cx="383" cy="130" r="33" fill="#4992b2" />
        <path d="M381 252v12l10-6z" fill="#f1785d" />
        <path d="M411 258h95" stroke="#546477" strokeWidth="3" />
        <rect x="637" y="51" width="151" height="221" rx="6" fill="#242936" />
        <g fill="#bbc9d9" fontFamily="system-ui, sans-serif" fontSize="11">
          <text x="650" y="76">Properties</text><text x="650" y="112">Selected clip</text>
          <text x="650" y="150">Position</text><text x="650" y="192">Duration</text>
        </g>
        <g fill="#343d50"><rect x="650" y="159" width="124" height="20" rx="3" /><rect x="650" y="201" width="124" height="20" rx="3" /></g>
        <rect x="12" y="284" width="776" height="153" rx="6" fill="#202633" />
        <g fill="#bbc9d9" fontFamily="system-ui, sans-serif" fontSize="10">
          <text x="25" y="306">Timeline</text><text x="123" y="306">0:00</text><text x="306" y="306">0:05</text><text x="490" y="306">0:10</text><text x="675" y="306">0:15</text>
          <text x="25" y="342">Track 3</text><text x="25" y="381">Track 2</text><text x="25" y="419">Track 1</text>
        </g>
        <g fill="#acdce1"><rect x="118" y="323" width="220" height="28" rx="4" /><rect x="343" y="323" width="180" height="28" rx="4" /></g>
        <rect x="254" y="361" width="357" height="28" rx="4" fill="#f2baa6" />
        <rect x="118" y="399" width="620" height="28" rx="4" fill="#b8dbcb" />
        <path d="M129 413h25l5-8 5 16 5-14 5 6h50l5-9 5 18 5-14 5 5h60l5-7 5 14 5-7h400" fill="none" stroke="#3a7766" strokeWidth="2" />
        <path d="M407 313v118" stroke="#f1785d" strokeWidth="2" /><path d="M400 312h14v7l-7 6-7-6z" fill="#f1785d" />
      </svg>
      <figcaption className="px-3 py-2 text-xs text-foreground-muted">Editor overview · Import, arrange, trim and generate.</figcaption>
    </figure>
  );
}
