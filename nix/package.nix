{
  lib,
  buildNpmPackage,
  importNpmLock,
  makeWrapper,
  nodejs_24,
}:

let
  manifest = lib.importJSON ../package.json;
  root = ../.;
in
buildNpmPackage {
  pname = "pi-daemon";
  inherit (manifest) version;

  src = lib.fileset.toSource {
    inherit root;
    fileset = lib.fileset.unions [
      ../package.json
      ../package-lock.json
      ../tsconfig.json
      ../tsconfig.build.json
      ../vite.config.ts
      ../src
      ../web
      ../installer
      ../compatibility.json
      ../README.md
      ../LICENSE
    ];
  };

  nodejs = nodejs_24;
  npmDeps = importNpmLock {
    package = manifest;
    packageLock = lib.importJSON ../package-lock.json;
  };
  npmConfigHook = importNpmLock.npmConfigHook;

  nativeBuildInputs = [ makeWrapper ];

  # setup opens the bundled Pi CLI for provider /login unless PI_DAEMON_PI overrides it.
  postInstall = ''
    wrapProgram $out/bin/pi-daemon \
      --set-default PI_DAEMON_PI $out/lib/node_modules/@edward40/pi-daemon/node_modules/.bin/pi
  '';

  passthru.nodejs = nodejs_24;

  meta = {
    description = manifest.description;
    homepage = "https://github.com/SASUKE40/pi-daemon";
    license = lib.licenses.mit;
    mainProgram = "pi-daemon";
    platforms = lib.platforms.linux ++ lib.platforms.darwin;
  };
}
