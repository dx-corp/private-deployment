{{/*
Expand the name of the chart.
*/}}
{{- define "audit.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "audit.fullname" -}}
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
Chart label.
*/}}
{{- define "audit.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels.
*/}}
{{- define "audit.labels" -}}
helm.sh/chart: {{ include "audit.chart" . }}
{{ include "audit.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels.
*/}}
{{- define "audit.selectorLabels" -}}
app.kubernetes.io/name: {{ include "audit.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Service account name.
*/}}
{{- define "audit.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "audit.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
Secret name.
*/}}
{{- define "audit.secretName" -}}
{{- default (include "audit.fullname" .) .Values.secret.existingSecretName }}
{{- end }}

{{/* Render a reviewed repository/digest, requiring nested pins in private mode. */}}
{{- define "audit.imageReference" -}}
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
