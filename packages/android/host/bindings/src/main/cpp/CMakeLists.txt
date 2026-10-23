cmake_minimum_required(VERSION 3.13)
project(simlessbindings)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(fbjni REQUIRED CONFIG)
find_package(ReactAndroid REQUIRED CONFIG)

add_library(simlessbindings SHARED SimlessBindings.cpp)
target_link_libraries(simlessbindings fbjni::fbjni ReactAndroid::jsi android log)
