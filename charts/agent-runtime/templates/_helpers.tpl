{{/*
Expand the name of the chart.
*/}}
{{- define "agent-runtime.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "agent-runtime.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "agent-runtime.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "agent-runtime.labels" -}}
helm.sh/chart: {{ include "agent-runtime.chart" . }}
{{ include "agent-runtime.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "agent-runtime.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-runtime.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the service account name to use.
*/}}
{{- define "agent-runtime.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent-runtime.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Create the runtime secret name to use.
*/}}
{{- define "agent-runtime.secretName" -}}
{{- default (include "agent-runtime.fullname" .) .Values.secret.existingSecretName }}
{{- end }}

{{/* Render a reviewed repository/digest, requiring nested pins in private mode. */}}
{{- define "agent-runtime.imageReference" -}}
{{- $image := index . 0 -}}
{{- $requireDigest := index . 1 -}}
{{- $repository := required "image.repository is required" $image.repository -}}
{{- if or (contains "@" $repository) (regexMatch "[:][^/]*$" $repository) (regexMatch "[[:space:]]" $repository) -}}
{{- fail "image.repository must not contain a tag, digest, or whitespace" -}}
{{- end -}}
{{- if $image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
{{- fail "image.digest must be sha256 followed by 64 lowercase hexadecimal characters" -}}
{{- end -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- if or $requireDigest $image.requireDigest -}}{{- fail "image.digest is required in digest-only mode" -}}{{- end -}}
{{- printf "%s:%s" $repository (required "image.tag is required without image.digest" $image.tag) -}}
{{- end -}}
{{- end -}}
