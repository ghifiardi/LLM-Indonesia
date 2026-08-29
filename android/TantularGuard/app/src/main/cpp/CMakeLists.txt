cmake_minimum_required(VERSION 3.22.1)

project(tantular_llama_android LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

# llama.cpp is intentionally vendored/fetched locally by scripts/fetch_llama_cpp.sh
# and is git-ignored. This keeps the repository small while making native builds
# reproducible once the dependency is present.
set(LLAMA_CPP_DIR ${CMAKE_CURRENT_SOURCE_DIR}/llama.cpp)

if(NOT EXISTS ${LLAMA_CPP_DIR}/CMakeLists.txt)
    message(FATAL_ERROR "llama.cpp not found at ${LLAMA_CPP_DIR}. Run android/TantularGuard/scripts/fetch_llama_cpp.sh first, or build without -PtantularNative=true.")
endif()

# Keep the Android runtime lean. These flags are supported by recent llama.cpp;
# unknown older versions may require adjusting the pinned commit in the fetch script.
set(LLAMA_BUILD_COMMON OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(LLAMA_BUILD_SERVER OFF CACHE BOOL "" FORCE)
set(LLAMA_CURL OFF CACHE BOOL "" FORCE)
set(LLAMA_OPENMP OFF CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)

add_subdirectory(${LLAMA_CPP_DIR} llama-build)

add_library(tantular-llama SHARED tantular_jni.cpp)

target_include_directories(tantular-llama PRIVATE
    ${LLAMA_CPP_DIR}/include
    ${LLAMA_CPP_DIR}/common
    ${LLAMA_CPP_DIR}/ggml/include
    ${LLAMA_CPP_DIR}/src
)

find_library(log-lib log)

target_link_libraries(tantular-llama
    llama
    ${log-lib}
)
