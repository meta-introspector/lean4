FROM debian

RUN apt update -y
#RUN apt get install -y cmake 
#RUN apt-get build-dep lean4
RUN apt-get install -y git libgmp-dev libuv1-dev cmake ccache clang pkgconf


WORKDIR /opt/lean4
#ADD . /opt/lean4
ADD src /opt/lean4/src/
ADD script /opt/lean4/script
ADD tests /opt/lean4/tests/
ADD stage0 /opt/lean4/stage0/
ADD CMakeLists.txt /opt/lean4/CMakeLists.txt
ADD CMakePresets.json /opt/lean4/CMakePresets.json
ADD lean-toolchain /opt/lean4/lean-toolchain
ADD lean.code-workspace /opt/lean4/lean.code-workspace

RUN cmake --preset release
RUN make -C build/release -j20
