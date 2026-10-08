# Windows runtime licenses and notices

The Windows helper is distributed as a self-contained .NET executable. These
files preserve the licenses and third-party notices for its bundled runtime;
the plugin's own MIT license does not replace them.

This checked-in snapshot corresponds to .NET Runtime and Windows Desktop
Runtime **8.0.31**, used by the initially published x64 and ARM64 binaries.
The license and .NET third-party notices came from the official NuGet runtime
packs at that exact version. The WPF notice came from the corresponding
[`dotnet/wpf` release tag](https://github.com/dotnet/wpf/blob/v8.0.31/THIRD-PARTY-NOTICES.TXT).
Only line endings were normalized to LF. `manifest.json` records the sources,
versions, and SHA-256 hashes; the x64 source package names identify the original
copies, and the same license texts apply to the ARM64 runtime packs.

After each Windows publication, `scripts/build-windows.ps1` asks MSBuild for
the actual resolved runtime pack versions and directories. It copies licenses
and notices from those restored packs into `publish/<runtime>/third-party/`.
It uses this checked-in WPF notice only when its version, source URL, and hash
match; otherwise it downloads the exact matching WPF release tag. Missing
notices or unavailable tags fail the build. The generated manifest contains
public source URLs and hashes, with no developer machine paths.

Distribute the generated `publish/<runtime>/third-party/` directory alongside
the helper. This checked-in directory remains available for the initial
8.0.31 binaries and source archives; future binaries use their generated
version-matched notices.
