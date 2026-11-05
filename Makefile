# Top-level glue. Business logic lives in services/*.
ROOT  := $(abspath .)
MUPDF := $(ROOT)/third_party/mupdf
EMSDK ?= $(HOME)/emsdk
MUPDF_FLAGS := brotli=no mujs=no extract=no

.PHONY: site all deps mupdf mupdf-native mupdf-wasm native wasm test test-asan test-wasm e2e eval serve hooks clean

all: wasm test

deps:
	scripts/fetch_deps.sh

mupdf: mupdf-native mupdf-wasm

mupdf-native:
	$(MAKE) -C $(MUPDF) -j$$(nproc) build=release HAVE_X11=no HAVE_GLUT=no HAVE_CURL=no \
	  XCFLAGS="-DTOFU_CJK_EXT -DFZ_ENABLE_HYPHEN=0" $(MUPDF_FLAGS) libs

# Browser build: no Noto/CJK fonts compiled in (they load lazily, see services/engine/src/fonts.cpp).
mupdf-wasm:
	bash -c 'source $(EMSDK)/emsdk_env.sh >/dev/null 2>&1 && $(MAKE) -C $(MUPDF) -j$$(nproc) OS=wasm build=release \
	  XCFLAGS="-DTOFU -DTOFU_CJK -DFZ_ENABLE_HYPHEN=0" $(MUPDF_FLAGS) libs'

native:
	$(MAKE) -C services/engine -j$$(nproc) native

wasm:
	$(MAKE) -C services/engine -j$$(nproc) wasm

# Gate tests: deterministic, local, fast (used by the pre-commit hook).
test: native
	services/engine/build/native/engine_tests
	cd services/web && node --test tests/unit/

test-asan:
	$(MAKE) -C services/engine -j$$(nproc) NATIVE_DIR=build/asan \
	  CXXFLAGS="-O1 -g -fsanitize=address,undefined -fno-omit-frame-pointer" build/asan/engine_tests
	services/engine/build/asan/engine_tests

test-wasm: wasm
	node --test services/engine/tests/wasm_smoke.mjs

e2e:
	cd services/web && npx playwright test

eval: native
	services/engine/evals/fetch_corpus.sh
	cd services/engine && python3 evals/run_eval.py --cli build/native/pdfedit-cli

# Deployable static site: only runtime files (no tests, no node_modules, no mock-only assets).
SITE := build/site
site: wasm
	rm -rf $(SITE) && mkdir -p $(SITE)
	cp -r services/web/index.html services/web/css services/web/js services/web/engine $(SITE)/
	cp LICENSE $(SITE)/LICENSE.txt
	touch $(SITE)/.nojekyll
	@du -sh $(SITE)

serve-site: site
	cd $(SITE) && python3 -m http.server 8766

serve:
	cd services/web && python3 -m http.server 8765

hooks:
	git config core.hooksPath .githooks

clean:
	$(MAKE) -C services/engine clean
	rm -rf build
