self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.pi-daemon;
  inherit (pkgs.stdenv.hostPlatform) isDarwin isLinux;

  packageDir = "${cfg.package}/lib/node_modules/@edward40/pi-daemon";
  node = lib.getExe cfg.package.passthru.nodejs;
  configDir = "${config.xdg.configHome}/pi-daemon";
  tokenFile = "${configDir}/tunnel-token";
  logDir = "${config.home.homeDirectory}/Library/Logs/pi-daemon";

  servicePath = lib.concatStringsSep ":" [
    (lib.makeBinPath cfg.extraPackages)
    "${config.home.profileDirectory}/bin"
    "/run/current-system/sw/bin"
    "/nix/var/nix/profiles/default/bin"
    "/usr/local/bin"
    "/usr/bin"
    "/bin"
  ];

  # Both the services and the user-facing CLI must agree on these so that
  # `pi-daemon setup` writes where the services read.
  sharedEnvironment = {
    PI_DAEMON_MANAGED_SERVICES = "1";
    PI_DAEMON_CONFIG_DIR = configDir;
  }
  // lib.optionalAttrs cfg.cloudflared.enable {
    PI_DAEMON_CLOUDFLARED = lib.getExe cfg.cloudflared.package;
  };

  serviceEnvironment = sharedEnvironment // { PATH = servicePath; } // cfg.environment;

  cli = pkgs.symlinkJoin {
    name = "pi-daemon-managed-${cfg.package.version}";
    paths = [ cfg.package ];
    nativeBuildInputs = [ pkgs.makeWrapper ];
    postBuild = ''
      wrapProgram $out/bin/pi-daemon ${
        lib.concatStringsSep " " (
          lib.mapAttrsToList (name: value: "--set ${name} ${lib.escapeShellArg value}") sharedEnvironment
        )
      }
    '';
    inherit (cfg.package) meta;
  };

  systemdService =
    {
      description,
      after,
      execStart,
      extraUnit ? { },
    }:
    {
      Unit = {
        Description = description;
        After = after;
      }
      // extraUnit;
      Service = {
        ExecStart = execStart;
        Restart = "on-failure";
        RestartSec = 2;
        Environment = lib.mapAttrsToList (name: value: "${name}=${value}") serviceEnvironment;
      };
      Install.WantedBy = [ "default.target" ];
    };

  launchAgent = name: arguments: extra: {
    enable = true;
    config = {
      Label = "com.edward40.pi-daemon.${name}";
      ProgramArguments = arguments;
      EnvironmentVariables = serviceEnvironment;
      RunAtLoad = true;
      KeepAlive.SuccessfulExit = false;
      ProcessType = "Interactive";
      StandardOutPath = "${logDir}/${name}.log";
      StandardErrorPath = "${logDir}/${name}.log";
    }
    // extra;
  };
in
{
  options.services.pi-daemon = {
    enable = lib.mkEnableOption "Pi Daemon, persistent Pi coding-agent sessions with a mobile web UI";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.pi-daemon.packages.\${pkgs.stdenv.hostPlatform.system}.default";
      description = "The Pi Daemon package to run.";
    };

    cloudflared = {
      enable = lib.mkEnableOption ''
        the cloudflared connector service for the Cloudflare Tunnel relay.
        It starts once `pi-daemon setup` has written the tunnel token'';
      package = lib.mkPackageOption pkgs "cloudflared" { };
    };

    extraPackages = lib.mkOption {
      type = lib.types.listOf lib.types.package;
      default = with pkgs; [
        bash
        coreutils
        git
        ripgrep
      ];
      defaultText = lib.literalExpression "with pkgs; [ bash coreutils git ripgrep ]";
      description = ''
        Packages placed first on the PATH of the Pi session daemon, in addition to the
        Home Manager profile. Pi's coding tools run commands with this PATH.
      '';
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        PI_CODING_AGENT_DIR = "/home/alice/.pi/agent";
      };
      description = "Extra environment variables for the Pi Daemon services.";
    };
  };

  config = lib.mkIf cfg.enable (
    lib.mkMerge [
      {
        assertions = [
          {
            assertion = isLinux || isDarwin;
            message = "services.pi-daemon supports only Linux and macOS.";
          }
        ];
        home.packages = [ cli ];
      }

      (lib.mkIf isLinux {
        systemd.user.services = {
          pi-daemon-sessiond = systemdService {
            description = "Pi Daemon session daemon";
            after = [ "network.target" ];
            execStart = "${node} ${packageDir}/dist/sessiond.js";
          };
          pi-daemon-web = systemdService {
            description = "Pi Daemon web gateway";
            after = [ "pi-daemon-sessiond.service" ];
            execStart = "${node} ${packageDir}/dist/web.js";
          };
          pi-daemon-cloudflared = lib.mkIf cfg.cloudflared.enable (systemdService {
            description = "Pi Daemon Cloudflare Tunnel connector";
            after = [
              "pi-daemon-web.service"
              "network-online.target"
            ];
            execStart = "${lib.getExe cfg.cloudflared.package} tunnel run --token-file ${tokenFile}";
            extraUnit.ConditionPathExists = tokenFile;
          });
        };
      })

      (lib.mkIf isDarwin {
        home.activation.piDaemonLogDir = lib.hm.dag.entryBetween [ "setupLaunchAgents" ] [ "writeBoundary" ] ''
          run mkdir -p ${lib.escapeShellArg logDir}
        '';
        launchd.agents = {
          pi-daemon-sessiond = launchAgent "sessiond" [ node "${packageDir}/dist/sessiond.js" ] { };
          pi-daemon-web = launchAgent "web" [ node "${packageDir}/dist/web.js" ] { };
          pi-daemon-cloudflared = lib.mkIf cfg.cloudflared.enable (
            launchAgent "cloudflared"
              [
                (lib.getExe cfg.cloudflared.package)
                "tunnel"
                "run"
                "--token-file"
                tokenFile
              ]
              {
                RunAtLoad = false;
                KeepAlive.PathState.${tokenFile} = true;
              }
          );
        };
      })
    ]
  );
}
