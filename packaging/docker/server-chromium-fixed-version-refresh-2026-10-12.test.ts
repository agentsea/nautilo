import {describe,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {evaluateVulnerabilityPolicy,parseVulnerabilityPolicy,type EvaluateVulnerabilityPolicyInput,type VulnerabilityPolicyV1} from "./vulnerability-policy";

type Architecture = "linux/amd64" | "linux/arm64";
type Tuple = ["grype" | "trivy",string,string,string,"high" | "critical",boolean,string[]];
const read=(name:string)=>JSON.parse(readFileSync(join(import.meta.dir,name),"utf8"));
const fixture=read("fixtures/server-chromium-fixed-version-refresh-2026-10-12.json") as {
  refreshedAt:string; priorInventory:string; findingCount:number; installedVersion:string; availableVersion:string;
  packages:string[]; architectures:Architecture[];
  cases:{advisoryId:string; severity:"high" | "critical"; previousFixable:boolean; previousFixedVersions:string[];
    fixedVersion:string; previousThreshold:string; primaryUrl:string; sourceStatus:string;
    sourceFixedVersion:string; originalReviewedAt:string; originalExpiresAt:string}[];
};
const earlier=read("fixtures/"+fixture.priorInventory) as {architectures:Record<Architecture,Tuple[]>};
const source=read("server-vulnerability-exceptions.input.json") as {exceptions:VulnerabilityPolicyV1["exceptions"]};
const revision=(e:{advisoryId:string;severity:string;packageName:string;installedVersion:string})=>
  fixture.packages.includes(e.packageName)&&e.installedVersion===fixture.installedVersion
    ? fixture.cases.find(c=>c.advisoryId===e.advisoryId&&c.severity===e.severity) : undefined;

function input(architecture:Architecture,previousPolicy=false):EvaluateVulnerabilityPolicyInput {
  const digest="sha256:"+"a".repeat(64),image={digest,reference:"registry.example/runtime@"+digest,sizeBytes:42};
  const exceptions=source.exceptions.map(e=>{
    const c=revision(e);
    return previousPolicy&&c&&e.unavailableFix?{...e,unavailableFix:{...e.unavailableFix,fixedVersion:c.previousThreshold}}:e;
  });
  const tuples=earlier.architectures[architecture].map(t=>{
    const c=t[0]==="trivy"?revision({advisoryId:t[1],severity:t[4],packageName:t[2],installedVersion:t[3]}):undefined;
    return c?[...t.slice(0,5),true,[c.fixedVersion]] as Tuple:t;
  });
  const binding={image:{digest,reference:image.reference},architecture,databases:{grype:"b".repeat(64),trivy:"c".repeat(64)}};
  const packages=[...new Map(exceptions.filter(e=>e.unavailableFix?.architecture===architecture).map(e=>[
    e.packageName+"\0"+e.unavailableFix!.fixedVersion,
    {packageName:e.packageName,installedVersion:e.installedVersion,availableVersion:e.unavailableFix!.availableVersion,
      fixedVersion:e.unavailableFix!.fixedVersion,fixAvailable:false},
  ])).values()];
  return {
    policy:parseVulnerabilityPolicy(JSON.stringify({version:1,binding,exceptions})),
    manifest:{version:1,sourceSha:"a".repeat(40),dockerfileSha256:digest,
      baseImages:[{role:"runtime",identity:"registry.example/base@"+digest}],architecture,image,
      tools:{grype:"1",trivy:"1"},databases:[{name:"grype",identity:"db",version:"1"}],capturedAt:fixture.refreshedAt},
    databaseIdentity:{version:1,databases:{
      grype:{provider:"anchore",schemaVersion:"v6",path:"/tmp/grype.db",sha256:binding.databases.grype},
      trivy:{provider:"aquasecurity",schemaVersion:"2",path:"/tmp/trivy.db",sha256:binding.databases.trivy},
    }},
    grype:{matches:tuples.filter(t=>t[0]==="grype").map(([,id,name,version,severity,,versions])=>({
      vulnerability:{id,severity,fix:{versions}},artifact:{name,version},
    }))},
    trivy:{Results:[{Vulnerabilities:tuples.filter(t=>t[0]==="trivy").map(([,id,name,version,severity,,versions])=>({
      VulnerabilityID:id,PkgName:name,InstalledVersion:version,Severity:severity,FixedVersion:versions.join(", "),
    }))}]},
    supportedPackageAvailability:{image,architecture,distribution:"debian:13",checkedAt:fixture.refreshedAt,
      verifiedBy:"apt-secure",signedIndexes:{trixie:"d".repeat(64),"trixie-updates":"e".repeat(64),"trixie-security":"f".repeat(64)},packages},
    evaluatedAt:fixture.refreshedAt,
  };
}

describe("exact Debian Chromium fixed-version metadata",()=>{
  test("refreshes existing risk bindings without changing severity, candidate, review dates or expiry",()=>{
    expect(fixture.cases).toHaveLength(74);
    expect(new Set(fixture.cases.map(c=>c.advisoryId)).size).toBe(74);
    expect(fixture.packages).toEqual(["chromium-common","chromium-headless-shell"]);
    expect(fixture.architectures).toEqual(["linux/amd64","linux/arm64"]);
    expect(earlier.architectures["linux/amd64"]).toEqual(earlier.architectures["linux/arm64"]);
    const updated=source.exceptions.filter(e=>revision(e));
    expect(updated).toHaveLength(296);
    expect(source.exceptions).toHaveLength(644);
    for(const e of updated){
      const c=revision(e)!;
      expect(c.sourceStatus).toBe("resolved");
      expect(c.sourceFixedVersion).toBe("155.0.8059.39-1~deb13u1");
      expect(c.fixedVersion).toBe(c.sourceFixedVersion);
      expect(e.unavailableFix).toEqual({architecture:e.unavailableFix!.architecture,distribution:"debian:13",
        availableVersion:fixture.availableVersion,fixedVersion:c.fixedVersion});
      expect(e.reviewedAt).toBe(c.originalReviewedAt);
      expect(e.expiresAt).toBe(c.originalExpiresAt);
      expect(e.rationale).toContain(c.primaryUrl);
      expect(e.rationale).toContain("Fixed-version metadata refreshed 2026-10-12");
    }
  });
  for(const architecture of fixture.architectures){
    test(architecture+": complete raw inventory passes only with the exact fresh unavailable-binary evidence",()=>{
      const current=input(architecture),report=evaluateVulnerabilityPolicy(current);
      expect(report.findings).toHaveLength(506);
      expect(report.passed).toBe(true);
      expect(report.failures).toEqual([]);
      expect(report.warnings).toEqual([]);
      const previous=evaluateVulnerabilityPolicy(input(architecture,true));
      expect(previous.passed).toBe(false);
      expect(previous.failures.filter(f=>f.code==="fixable-high-critical")).toHaveLength(148);
      expect(previous.failures.filter(f=>f.code==="unmatched-high-critical")).toHaveLength(148);
      expect(previous.warnings).toEqual([]);
      expect(evaluateVulnerabilityPolicy({...current,supportedPackageAvailability:undefined}).passed).toBe(false);
      const proof=current.supportedPackageAvailability!;
      for(const change of [{checkedAt:"2026-10-11T00:00:00Z"},{signedIndexes:{}},
        {packages:proof.packages.map(p=>({...p,availableVersion:p.fixedVersion,fixAvailable:true}))},
        {packages:proof.packages.map(p=>({...p,availableVersion:"155.0.8059.39-1~deb13u1"}))}]){
        expect(evaluateVulnerabilityPolicy({...current,supportedPackageAvailability:{...proof,...change}}).passed).toBe(false);
      }
      expect(evaluateVulnerabilityPolicy({...current,evaluatedAt:"2026-10-18T00:00:00Z"}).passed).toBe(false);
    });
  }
});
