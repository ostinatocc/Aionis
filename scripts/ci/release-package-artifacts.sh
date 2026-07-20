#!/usr/bin/env bash
set -euo pipefail

checkout_release_packages() {
  local release_train="${1:-}" destination="${2:-}"
  if [[ ! -f "${release_train}" || -L "${release_train}" || -z "${destination}" || -e "${destination}" ]]; then
    echo "checkout requires a regular release-train.json and a new destination directory" >&2
    return 2
  fi
  mkdir -p "${destination}"

  local coordinates
  coordinates="$(
  RELEASE_TRAIN="${release_train}" node --input-type=module <<'NODE'
    import fs from "node:fs";
    const train = JSON.parse(fs.readFileSync(process.env.RELEASE_TRAIN, "utf8"));
    const contracts = {
      cli: ["https://github.com/ostinatocc/aionis-cli.git", "aionis-cli"],
      create: ["https://github.com/ostinatocc/aionis-create.git", "aionis-create"],
      sdk: ["https://github.com/ostinatocc/aionis-sdk.git", "aionis-sdk"],
      manifest: ["https://github.com/ostinatocc/AionisManifest.git", "AionisManifest"],
      mcp: ["https://github.com/ostinatocc/aionis-mcp.git", "aionis-mcp"],
      aifs: ["https://github.com/ostinatocc/aionis-aifs.git", "aionis-aifs"],
      claude_code: ["https://github.com/ostinatocc/aionis-claude-code.git", "aionis-claude-code"],
      substrate: ["https://github.com/ostinatocc/AionisSubstrate.git", "AionisSubstrate"],
    };
    const immutable = /^(?:[0-9a-f]{40}|v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;
    const rows = [];
    if (!train.packages || Object.keys(train.packages).sort().join(",") !== Object.keys(contracts).sort().join(",")) {
      throw new Error("release package keys do not match the checkout contract");
    }
    for (const key of Object.keys(contracts)) {
      const [repository, checkoutPath] = contracts[key];
      const entry = train.packages[key];
      if (entry?.repository !== repository || !immutable.test(entry?.source_ref ?? "")
        || !/^[0-9a-f]{40}$/.test(entry?.source_commit ?? "")) {
        throw new Error(`invalid immutable checkout coordinates for ${key}`);
      }
      rows.push([repository, entry.source_ref, entry.source_commit, checkoutPath]);
    }
    if (train.status === "stable") {
      const verifier = train.stable_promotion?.verifier;
      if (verifier?.repository !== "https://github.com/ostinatocc/AionisRuntime-evals.git"
        || verifier?.source_ref !== verifier?.source_commit
        || !/^[0-9a-f]{40}$/.test(verifier?.source_commit ?? "")) {
        throw new Error("stable evaluation authority checkout coordinates are invalid");
      }
      rows.push([verifier.repository, verifier.source_commit, verifier.source_commit, "AionisRuntime-evals"]);
    }
  process.stdout.write(`${rows.map((row) => row.join("\t")).join("\n")}\n`);
NODE
  )"

  while IFS=$'\t' read -r repository source_ref source_commit checkout_path; do
    [[ -n "${repository}" ]] || continue
    local target="${destination}/${checkout_path}"
    mkdir -p "${target}"
    git -C "${target}" init --quiet
    git -C "${target}" remote add origin "${repository}"
    if [[ "${source_ref}" =~ ^[0-9a-f]{40}$ ]]; then
      git -C "${target}" fetch --quiet --no-tags --depth=1 origin "${source_ref}"
      git -C "${target}" checkout --quiet --detach FETCH_HEAD
    else
      git -C "${target}" fetch --quiet --no-tags --depth=1 origin \
        "refs/tags/${source_ref}:refs/tags/${source_ref}"
      git -C "${target}" checkout --quiet --detach "${source_ref}^{commit}"
    fi
    test "$(git -C "${target}" rev-parse 'HEAD^{commit}')" = "${source_commit}"
    test -z "$(git -C "${target}" status --porcelain=v1 --untracked-files=all)"
  done <<< "${coordinates}"
}

verify_published_create() {
  local create_spec="${1:-}" expected_version="${2:-}"
  local expected_commit="${3:-}" frozen_tarball="${4:-}"
  if [[ "${create_spec}" != "@aionis/create@${expected_version}" \
    || ! "${expected_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ \
    || ! "${expected_commit}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "verify-published-create requires an exact package, version, commit, and frozen tarball" >&2
    return 2
  fi
  if [[ ! -f "${frozen_tarball}" || -L "${frozen_tarball}" ]]; then
    echo "frozen Create tarball must be a regular non-symlink file" >&2
    return 2
  fi

  local published_metadata
  published_metadata="$(npm view "${create_spec}" name version gitHead --json)"
  PUBLISHED_METADATA="${published_metadata}" EXPECTED_VERSION="${expected_version}" \
    EXPECTED_COMMIT="${expected_commit}" node --input-type=module <<'NODE'
  const value = JSON.parse(process.env.PUBLISHED_METADATA);
  if (value?.name !== "@aionis/create"
    || value?.version !== process.env.EXPECTED_VERSION
    || value?.gitHead !== process.env.EXPECTED_COMMIT
    || Object.keys(value).sort().join(",") !== "gitHead,name,version") {
    throw new Error(`published Create identity mismatch: ${JSON.stringify(value)}`);
  }
NODE

  local temp_root published_filename published_tgz
  temp_root="$(mktemp -d)"
  cleanup_create_verification() {
    rm -rf -- "${temp_root}"
  }
  trap cleanup_create_verification EXIT
  mkdir -p "${temp_root}/pack" "${temp_root}/published" "${temp_root}/frozen"
  published_filename="$(npm pack --silent --pack-destination "${temp_root}/pack" "${create_spec}" | tail -n 1)"
  published_tgz="${temp_root}/pack/$(basename "${published_filename}")"
  test -f "${published_tgz}"
  tar -xzf "${published_tgz}" -C "${temp_root}/published"
  tar -xzf "${frozen_tarball}" -C "${temp_root}/frozen"
  diff --recursive --brief --no-dereference \
    "${temp_root}/frozen/package" "${temp_root}/published/package"
  cleanup_create_verification
  trap - EXIT
}

mode="${1:-}"
shift || true
case "${mode}" in
  checkout) checkout_release_packages "$@" ;;
  verify-published-create) verify_published_create "$@" ;;
  *) echo "usage: $0 checkout <release-train.json> <new-directory> | verify-published-create <spec> <version> <commit> <frozen.tgz>" >&2; exit 2 ;;
esac
